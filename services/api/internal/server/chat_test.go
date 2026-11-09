package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

type channel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Topic       string `json:"topic"`
	Visibility  string `json:"visibility"`
	IsDefault   bool   `json:"isDefault"`
	MemberCount int    `json:"memberCount"`
	Joined      bool   `json:"joined"`
	UnreadCount int    `json:"unreadCount"`
}

type message struct {
	ID     string `json:"id"`
	Body   string `json:"body"`
	Author *struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
	} `json:"author"`
	EditedAt *string `json:"editedAt"`
}

func (c *client) channelList(orgID, path string) []channel {
	c.t.Helper()
	var out struct {
		Channels []channel `json:"channels"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+path, nil).decode(c.t, &out)
	return out.Channels
}

func (c *client) channels(orgID string) []channel { return c.channelList(orgID, "/channels") }

func (c *client) createChannel(orgID string, body map[string]any) channel {
	c.t.Helper()
	var out struct {
		Channel channel `json:"channel"`
	}
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/channels", body).decode(c.t, &out)
	return out.Channel
}

func (c *client) post(orgID, channelID, body string) message {
	c.t.Helper()
	var out struct {
		Message message `json:"message"`
	}
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/channels/"+channelID+"/messages",
		map[string]string{"body": body}).decode(c.t, &out)
	return out.Message
}

type history struct {
	Messages []message `json:"messages"`
	HasMore  bool      `json:"hasMore"`
}

func (c *client) history(orgID, channelID, query string) history {
	c.t.Helper()
	var out history
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/channels/"+channelID+"/messages"+query, nil).decode(c.t, &out)
	return out
}

func find(chans []channel, name string) *channel {
	for i := range chans {
		if chans[i].Name == name {
			return &chans[i]
		}
	}
	return nil
}

func TestDefaultChannelAndChannelPermissions(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()

	chans := owner.channels(orgID)
	if len(chans) != 1 || chans[0].Name != "genel" || !chans[0].IsDefault || !chans[0].Joined {
		t.Fatalf("owner channels = %+v, want the joined default channel genel", chans)
	}
	general := chans[0].ID

	// Every join path goes through the memberships trigger.
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	if got := emp.channels(orgID); len(got) != 1 || got[0].ID != general {
		t.Fatalf("employee channels = %+v, want genel", got)
	}
	expectError(t, emp.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/channels/"+general+"/leave", nil), http.StatusConflict, "default_channel")

	// Guests see only what they are added to.
	guest, guestID := ts.join(owner, orgID, "guest@example.com", "guest")
	if got := guest.channels(orgID); len(got) != 0 {
		t.Fatalf("guest channels = %+v, want none", got)
	}
	base := "/api/v1/orgs/" + orgID + "/channels"
	expectError(t, guest.do(http.MethodGet, base+"/browse", nil), http.StatusForbidden, "forbidden")
	expectError(t, guest.do(http.MethodPost, base, map[string]any{"name": "x", "visibility": "public"}), http.StatusForbidden, "forbidden")
	expectError(t, guest.do(http.MethodGet, base+"/"+general, nil), http.StatusNotFound, "not_found")
	expectError(t, guest.do(http.MethodPost, base+"/"+general+"/join", nil), http.StatusNotFound, "not_found")

	// An invited guest can take part.
	shared := owner.createChannel(orgID, map[string]any{"name": "Proje Alfa", "visibility": "public", "memberIds": []string{guestID}})
	if shared.Name != "proje-alfa" || shared.MemberCount != 2 {
		t.Fatalf("created channel = %+v", shared)
	}
	guest.post(orgID, shared.ID, "Merhaba!")
	if got := guest.channels(orgID); len(got) != 1 || got[0].ID != shared.ID {
		t.Fatalf("guest channels = %+v, want proje-alfa", got)
	}

	// Validation.
	r := owner.do(http.MethodPost, base, map[string]any{"name": "#Proje-Alfa", "visibility": "public"})
	expectError(t, r, http.StatusUnprocessableEntity, "validation_failed")
	var e apiError
	r.decode(t, &e)
	if e.Error.Fields["name"] == "" {
		t.Fatalf("duplicate name error = %s", r.body)
	}
	r = owner.do(http.MethodPost, base, map[string]any{"name": "a!", "topic": strings.Repeat("x", 251), "visibility": "secret"})
	r.decode(t, &e)
	if len(e.Error.Fields) != 3 {
		t.Fatalf("validation fields = %v", e.Error.Fields)
	}
}

func TestChannelMessaging(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	base := "/api/v1/orgs/" + orgID + "/channels/"

	support := owner.createChannel(orgID, map[string]any{"name": "Müşteri Destek", "topic": "  Yardım\nmasası ", "visibility": "public"})
	if support.Name != "müşteri-destek" || support.Topic != "Yardım masası" {
		t.Fatalf("created channel = %+v", support)
	}

	// Public channels can be read before joining; posting needs membership.
	browse := emp.channelList(orgID, "/channels/browse")
	if c := find(browse, "müşteri-destek"); c == nil || c.Joined {
		t.Fatalf("browse = %+v, want müşteri-destek not joined", browse)
	}
	expectError(t, emp.do(http.MethodPost, base+support.ID+"/messages", map[string]string{"body": "hi"}), http.StatusForbidden, "not_channel_member")
	emp.history(orgID, support.ID, "")
	emp.must(http.StatusOK, http.MethodPost, base+support.ID+"/join", nil)

	m1 := owner.post(orgID, support.ID, "Birinci")
	m2 := owner.post(orgID, support.ID, "İkinci\nsatır")
	m3 := owner.post(orgID, support.ID, "Üçüncü")
	if c := find(emp.channels(orgID), "müşteri-destek"); c == nil || c.UnreadCount != 3 {
		t.Fatalf("employee unread = %+v, want 3", c)
	}
	if c := find(owner.channels(orgID), "müşteri-destek"); c.UnreadCount != 0 {
		t.Fatalf("author unread = %d, want 0", c.UnreadCount)
	}

	// History pages newest first, each page in chronological order.
	page := emp.history(orgID, support.ID, "?limit=2")
	if !page.HasMore || len(page.Messages) != 2 || page.Messages[0].ID != m2.ID || page.Messages[1].ID != m3.ID {
		t.Fatalf("first page = %+v", page)
	}
	if page.Messages[0].Body != "İkinci\nsatır" || page.Messages[0].Author.DisplayName != "Alex Owner" {
		t.Fatalf("message = %+v", page.Messages[0])
	}
	page = emp.history(orgID, support.ID, "?limit=2&before="+m2.ID)
	if page.HasMore || len(page.Messages) != 1 || page.Messages[0].ID != m1.ID {
		t.Fatalf("second page = %+v", page)
	}
	expectError(t, emp.do(http.MethodGet, base+support.ID+"/messages?before=nope", nil), http.StatusBadRequest, "invalid_cursor")

	emp.must(http.StatusNoContent, http.MethodPost, base+support.ID+"/read", map[string]string{"messageId": m3.ID})
	emp.must(http.StatusNoContent, http.MethodPost, base+support.ID+"/read", map[string]string{"messageId": m1.ID}) // never moves back
	if c := find(emp.channels(orgID), "müşteri-destek"); c.UnreadCount != 0 {
		t.Fatalf("unread after reading = %d", c.UnreadCount)
	}

	// Editing is for authors only.
	expectError(t, emp.do(http.MethodPatch, base+support.ID+"/messages/"+m1.ID, map[string]string{"body": "hacked"}), http.StatusForbidden, "forbidden")
	var edited struct {
		Message message `json:"message"`
	}
	owner.must(http.StatusOK, http.MethodPatch, base+support.ID+"/messages/"+m1.ID, map[string]string{"body": "Birinci (düzeltildi)"}).decode(t, &edited)
	if edited.Message.Body != "Birinci (düzeltildi)" || edited.Message.EditedAt == nil {
		t.Fatalf("edited = %+v", edited.Message)
	}

	// Members delete their own messages; moderators delete anyone's, with an audit record.
	expectError(t, emp.do(http.MethodDelete, base+support.ID+"/messages/"+m2.ID, nil), http.StatusForbidden, "forbidden")
	mine := emp.post(orgID, support.ID, "Silinecek")
	owner.must(http.StatusNoContent, http.MethodDelete, base+support.ID+"/messages/"+mine.ID, nil)
	owner.must(http.StatusNoContent, http.MethodDelete, base+support.ID+"/messages/"+m3.ID, nil)
	expectError(t, owner.do(http.MethodDelete, base+support.ID+"/messages/"+m3.ID, nil), http.StatusNotFound, "not_found")
	if got := owner.history(orgID, support.ID, ""); len(got.Messages) != 2 {
		t.Fatalf("history after deletes = %+v", got)
	}
	var events struct {
		Events []struct {
			Action   string         `json:"action"`
			Metadata map[string]any `json:"metadata"`
		} `json:"events"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/audit-events", nil).decode(t, &events)
	moderated := slices.IndexFunc(events.Events, func(e struct {
		Action   string         `json:"action"`
		Metadata map[string]any `json:"metadata"`
	}) bool {
		return e.Action == "message.deleted"
	})
	if moderated < 0 || events.Events[moderated].Metadata["authorId"] != empID {
		t.Fatalf("audit events = %+v, want one message.deleted for the employee's message", events.Events)
	}

	// Message validation.
	expectError(t, owner.do(http.MethodPost, base+support.ID+"/messages", map[string]string{"body": " \n\t "}), http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPost, base+support.ID+"/messages", map[string]string{"body": strings.Repeat("ş", 4001)}), http.StatusUnprocessableEntity, "validation_failed")
	owner.post(orgID, support.ID, strings.Repeat("ş", 4000))

	// Leaving and renaming.
	emp.must(http.StatusNoContent, http.MethodPost, base+support.ID+"/leave", nil)
	if find(emp.channels(orgID), "müşteri-destek") != nil {
		t.Fatal("left channel still listed")
	}
	expectError(t, emp.do(http.MethodPatch, base+support.ID, map[string]string{"name": "x"}), http.StatusForbidden, "forbidden")
	owner.must(http.StatusOK, http.MethodPatch, base+support.ID, map[string]string{"name": "Destek"})
	if find(owner.channels(orgID), "destek") == nil {
		t.Fatal("rename not applied")
	}
}

func TestPrivateChannels(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	base := "/api/v1/orgs/" + orgID + "/channels/"

	// Private channels are invisible to non-members — workspace owners included.
	secret := dev.createChannel(orgID, map[string]any{"name": "gizli", "visibility": "private"})
	for _, c := range []*client{owner, emp} {
		if find(c.channelList(orgID, "/channels/browse"), "gizli") != nil {
			t.Fatal("private channel listed in browse")
		}
		for _, path := range []string{"", "/messages", "/members"} {
			expectError(t, c.do(http.MethodGet, base+secret.ID+path, nil), http.StatusNotFound, "not_found")
		}
		expectError(t, c.do(http.MethodPost, base+secret.ID+"/join", nil), http.StatusNotFound, "not_found")
		expectError(t, c.do(http.MethodPost, base+secret.ID+"/messages", map[string]string{"body": "x"}), http.StatusNotFound, "not_found")
	}

	// Members add people; only workspace members can be added.
	expectError(t, dev.do(http.MethodPost, base+secret.ID+"/members", map[string]any{"userIds": []string{"0190a8b4-0000-7000-8000-000000000000"}}),
		http.StatusUnprocessableEntity, "validation_failed")
	dev.must(http.StatusOK, http.MethodPost, base+secret.ID+"/members", map[string]any{"userIds": []string{empID}})
	if find(emp.channels(orgID), "gizli") == nil {
		t.Fatal("added member does not see the channel")
	}
	var members struct {
		Members []struct {
			User struct {
				ID string `json:"id"`
			} `json:"user"`
		} `json:"members"`
	}
	emp.must(http.StatusOK, http.MethodGet, base+secret.ID+"/members", nil).decode(t, &members)
	if len(members.Members) != 2 {
		t.Fatalf("members = %+v", members)
	}

	// The creator removes members; other members cannot.
	expectError(t, emp.do(http.MethodDelete, base+secret.ID+"/members/"+devID, nil), http.StatusForbidden, "forbidden")
	dev.must(http.StatusNoContent, http.MethodDelete, base+secret.ID+"/members/"+empID, nil)
	expectError(t, emp.do(http.MethodGet, base+secret.ID, nil), http.StatusNotFound, "not_found")

	// Channels never cross workspaces.
	var created struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs", map[string]string{"name": "Finance"}).decode(t, &created)
	general := owner.channels(orgID)[0].ID
	expectError(t, owner.do(http.MethodGet, "/api/v1/orgs/"+created.Organization.ID+"/channels/"+general, nil), http.StatusNotFound, "not_found")
	expectError(t, owner.do(http.MethodPost, "/api/v1/orgs/"+created.Organization.ID+"/channels",
		map[string]any{"name": "x", "visibility": "public", "memberIds": []string{devID}}), http.StatusUnprocessableEntity, "validation_failed")
}

// eventStream reads a client's live event stream.
type eventStream struct {
	t      *testing.T
	events chan sseEvent
	cancel context.CancelFunc
	// connectionID identifies the stream when reporting activity.
	connectionID string
}

type sseEvent struct {
	Type string
	Data json.RawMessage
}

// events opens the client's stream without presence, typing and notification events,
// which arrive alongside the ones a test checks in order; allEvents keeps them.
func (c *client) events() *eventStream {
	c.t.Helper()
	return c.openEvents(false)
}

func (c *client) allEvents() *eventStream {
	c.t.Helper()
	return c.openEvents(true)
}

func (c *client) openEvents(all bool) *eventStream {
	c.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/v1/events", nil)
	if err != nil {
		c.t.Fatal(err)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" {
		c.t.Fatalf("events: status %d, content type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	s := &eventStream{t: c.t, events: make(chan sseEvent, 100), cancel: cancel}
	go func() {
		defer resp.Body.Close()
		defer close(s.events)
		sc := bufio.NewScanner(resp.Body)
		var ev sseEvent
		for sc.Scan() {
			switch line := sc.Text(); {
			case line == "":
				if ev.Type != "" && (all || !incidental(ev.Type)) {
					s.events <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, "event: "):
				ev.Type = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.Data = json.RawMessage(strings.TrimPrefix(line, "data: "))
			}
		}
	}()
	c.t.Cleanup(cancel)
	var ready struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := json.Unmarshal(s.next("ready").Data, &ready); err != nil || ready.ConnectionID == "" {
		c.t.Fatalf("ready event without a connection ID: %v", err)
	}
	s.connectionID = ready.ConnectionID
	return s
}

// waitFor skips events until one of type typ satisfies match.
func (s *eventStream) waitFor(typ string, match func(data json.RawMessage) bool) sseEvent {
	s.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-s.events:
			if !ok {
				s.t.Fatalf("stream closed while waiting for %s", typ)
			}
			if ev.Type == typ && match(ev.Data) {
				return ev
			}
		case <-deadline:
			s.t.Fatalf("no matching %s event within 5s", typ)
		}
	}
}

// next returns the next event and fails unless it has type typ.
func (s *eventStream) next(typ string) sseEvent {
	s.t.Helper()
	select {
	case ev, ok := <-s.events:
		if !ok {
			s.t.Fatalf("stream closed while waiting for %s", typ)
		}
		if ev.Type != typ {
			s.t.Fatalf("got event %s %s, want %s", ev.Type, ev.Data, typ)
		}
		return ev
	case <-time.After(5 * time.Second):
		s.t.Fatalf("no %s event within 5s", typ)
	}
	return sseEvent{}
}

// quiet fails if an event arrives. Events are queued before the triggering request
// returns, so a short wait suffices.
func (s *eventStream) quiet() {
	s.t.Helper()
	select {
	case ev, ok := <-s.events:
		if ok {
			s.t.Fatalf("unexpected event %s %s", ev.Type, ev.Data)
		}
		s.t.Fatal("stream closed unexpectedly")
	case <-time.After(300 * time.Millisecond):
	}
}

// closed waits for the server to end the stream.
func (s *eventStream) closed() {
	s.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-s.events:
			if !ok {
				return
			}
		case <-deadline:
			s.t.Fatal("stream still open")
		}
	}
}

func TestLiveEvents(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	guest, guestID := ts.join(owner, orgID, "guest@example.com", "guest")
	base := "/api/v1/orgs/" + orgID + "/channels/"
	live := owner.createChannel(orgID, map[string]any{"name": "canli", "visibility": "public"})
	emp.must(http.StatusOK, http.MethodPost, base+live.ID+"/join", nil)

	empEvents, guestEvents := emp.events(), guest.events()
	other := ts.signIn("emp@example.com").events() // the employee's second device

	msg := owner.post(orgID, live.ID, "Canlı mesaj")
	var created struct {
		ChannelID string  `json:"channelId"`
		Message   message `json:"message"`
	}
	if err := json.Unmarshal(empEvents.next("message.created").Data, &created); err != nil {
		t.Fatal(err)
	}
	if created.ChannelID != live.ID || created.Message.Body != "Canlı mesaj" {
		t.Fatalf("event = %+v", created)
	}
	other.next("message.created")
	guestEvents.quiet() // not a member

	owner.must(http.StatusOK, http.MethodPatch, base+live.ID+"/messages/"+msg.ID, map[string]string{"body": "Düzeltildi"})
	empEvents.next("message.updated")
	other.next("message.updated")

	// Reading on one device clears the badge on the others.
	emp.must(http.StatusNoContent, http.MethodPost, base+live.ID+"/read", map[string]string{"messageId": msg.ID})
	empEvents.next("channel.read")
	other.next("channel.read")

	owner.must(http.StatusNoContent, http.MethodDelete, base+live.ID+"/messages/"+msg.ID, nil)
	empEvents.next("message.deleted")
	other.next("message.deleted")

	// Removed channel members stop receiving the channel's events at once.
	owner.must(http.StatusNoContent, http.MethodDelete, base+live.ID+"/members/"+empID, nil)
	empEvents.next("channel.left")
	other.next("channel.left")
	owner.post(orgID, live.ID, "Artık göremezsin")
	empEvents.quiet()

	// So do people removed from the workspace.
	general := owner.channels(orgID)[0].ID
	owner.post(orgID, general, "Herkese merhaba")
	empEvents.next("message.created")
	other.next("message.created")
	owner.must(http.StatusNoContent, http.MethodDelete, "/api/v1/orgs/"+orgID+"/members/"+empID, nil)
	owner.post(orgID, general, "Görüşürüz")
	empEvents.quiet()

	// People who are added are told, and members see the new member count.
	owner.must(http.StatusOK, http.MethodPost, base+live.ID+"/members", map[string]any{"userIds": []string{guestID}})
	guestEvents.next("channel.joined")
	var members struct {
		MemberCount int `json:"memberCount"`
	}
	if err := json.Unmarshal(guestEvents.next("channel.members").Data, &members); err != nil || members.MemberCount != 2 {
		t.Fatalf("channel.members = %+v, %v; want 2 members", members, err)
	}
	empEvents.quiet()

	// Signing out ends the session's stream.
	guest.must(http.StatusNoContent, http.MethodPost, "/api/v1/auth/logout", nil)
	guestEvents.closed()
	expectError(t, guest.do(http.MethodGet, "/api/v1/events", nil), http.StatusUnauthorized, "unauthorized")
}

func incidental(typ string) bool {
	return typ == "presence.changed" || typ == "typing" || strings.HasPrefix(typ, "notification.")
}
