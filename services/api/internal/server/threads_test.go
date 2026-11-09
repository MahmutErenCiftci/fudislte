package server_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
)

type richMessage struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parentId"`
	Body     string  `json:"body"`
	Deleted  bool    `json:"deleted"`
	Mentions []struct {
		ID string `json:"id"`
	} `json:"mentions"`
	Reactions []struct {
		Emoji string `json:"emoji"`
		Users []struct {
			ID string `json:"id"`
		} `json:"users"`
	} `json:"reactions"`
	Pinned *struct {
		By struct {
			ID string `json:"id"`
		} `json:"by"`
	} `json:"pinned"`
	Thread *struct {
		ReplyCount int         `json:"replyCount"`
		Latest     richMessage `json:"latest"`
	} `json:"thread"`
}

func (c *client) postRich(orgID, channelID string, body map[string]any) richMessage {
	c.t.Helper()
	var out struct {
		Message richMessage `json:"message"`
	}
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/channels/"+channelID+"/messages", body).decode(c.t, &out)
	return out.Message
}

func (c *client) richHistory(orgID, channelID string) []richMessage {
	c.t.Helper()
	var out struct {
		Messages []richMessage `json:"messages"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/channels/"+channelID+"/messages", nil).decode(c.t, &out)
	return out.Messages
}

func TestThreads(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	general := owner.channels(orgID)[0].ID
	other := owner.createChannel(orgID, map[string]any{"name": "diger", "visibility": "public"})
	base := "/api/v1/orgs/" + orgID + "/channels/" + general

	root := owner.postRich(orgID, general, map[string]any{"body": "Yeni sürüm hazır mı?"})
	reply := emp.postRich(orgID, general, map[string]any{"body": "Testler sürüyor.", "parentId": root.ID})
	if reply.ParentID == nil || *reply.ParentID != root.ID {
		t.Fatalf("reply = %+v", reply)
	}

	// The channel shows the root with a summary; replies do not count as unread.
	history := owner.richHistory(orgID, general)
	if len(history) != 1 || history[0].Thread == nil || history[0].Thread.ReplyCount != 1 || history[0].Thread.Latest.Body != "Testler sürüyor." {
		t.Fatalf("history = %+v", history)
	}
	if c := find(owner.channels(orgID), "genel"); c.UnreadCount != 0 {
		t.Fatalf("thread replies counted as unread: %d", c.UnreadCount)
	}
	var thread struct {
		Root    richMessage   `json:"root"`
		Replies []richMessage `json:"replies"`
	}
	owner.must(http.StatusOK, http.MethodGet, base+"/messages/"+root.ID+"/replies", nil).decode(t, &thread)
	if thread.Root.ID != root.ID || len(thread.Replies) != 1 || thread.Replies[0].ID != reply.ID {
		t.Fatalf("thread = %+v", thread)
	}
	expectError(t, owner.do(http.MethodGet, base+"/messages/"+reply.ID+"/replies", nil), http.StatusNotFound, "not_found")

	// One level only, and only within the channel.
	expectError(t, emp.do(http.MethodPost, base+"/messages", map[string]any{"body": "x", "parentId": reply.ID}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/channels/"+other.ID+"/messages", map[string]any{"body": "x", "parentId": root.ID}),
		http.StatusUnprocessableEntity, "validation_failed")

	// Deleting a root with replies leaves a placeholder; it goes with the last reply.
	owner.must(http.StatusNoContent, http.MethodDelete, base+"/messages/"+root.ID, nil)
	history = owner.richHistory(orgID, general)
	if len(history) != 1 || !history[0].Deleted || history[0].Body != "" || history[0].Thread.ReplyCount != 1 {
		t.Fatalf("placeholder = %+v", history)
	}
	expectError(t, owner.do(http.MethodPatch, base+"/messages/"+root.ID, map[string]string{"body": "geri"}), http.StatusNotFound, "not_found")
	emp.must(http.StatusNoContent, http.MethodDelete, base+"/messages/"+reply.ID, nil)
	if history = owner.richHistory(orgID, general); len(history) != 0 {
		t.Fatalf("placeholder survived its last reply: %+v", history)
	}
}

func TestReactionsMentionsAndPins(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	ownerID := owner.me().User.ID
	general := owner.channels(orgID)[0].ID
	base := "/api/v1/orgs/" + orgID + "/channels/" + general + "/messages/"

	// Mentions resolve to workspace members only and follow edits.
	msg := owner.postRich(orgID, general, map[string]any{"body": "Selam <@" + empID + "> ve <@0190a8b4-0000-7000-8000-000000000000>"})
	if len(msg.Mentions) != 1 || msg.Mentions[0].ID != empID {
		t.Fatalf("mentions = %+v", msg.Mentions)
	}
	var edited struct {
		Message richMessage `json:"message"`
	}
	owner.must(http.StatusOK, http.MethodPatch, base+msg.ID, map[string]string{"body": "Selam herkese"}).decode(t, &edited)
	if len(edited.Message.Mentions) != 0 {
		t.Fatalf("mentions after edit = %+v", edited.Message.Mentions)
	}

	// Reactions: idempotent per person, grouped by emoji in first-use order.
	react := func(c *client, emoji string) {
		t.Helper()
		c.must(http.StatusOK, http.MethodPost, base+msg.ID+"/reactions", map[string]string{"emoji": emoji})
	}
	react(emp, "👍")
	react(emp, "👍")
	react(owner, "👍")
	react(emp, "❤️")
	react(emp, "👍🏽")
	react(emp, "🇹🇷")
	react(emp, "1️⃣")
	got := owner.richHistory(orgID, general)[0].Reactions
	if len(got) != 5 || got[0].Emoji != "👍" || len(got[0].Users) != 2 || got[0].Users[0].ID != empID || got[1].Emoji != "❤️" {
		t.Fatalf("reactions = %+v", got)
	}
	emp.must(http.StatusOK, http.MethodDelete, base+msg.ID+"/reactions?emoji="+url.QueryEscape("👍"), nil)
	if got = owner.richHistory(orgID, general)[0].Reactions; len(got[0].Users) != 1 || got[0].Users[0].ID != ownerID {
		t.Fatalf("after removal = %+v", got)
	}
	for _, bad := range []string{"", "abc", "1", "👍 ok", "<script>"} {
		expectError(t, emp.do(http.MethodPost, base+msg.ID+"/reactions", map[string]string{"emoji": bad}), http.StatusUnprocessableEntity, "validation_failed")
	}
	for _, e := range []string{"😀", "😂", "🎉", "👀", "🙏", "🔥", "✅", "🚀", "💯", "😍", "🤔", "👏", "😢", "😮", "🙌"} {
		react(emp, e)
	}
	expectError(t, emp.do(http.MethodPost, base+msg.ID+"/reactions", map[string]string{"emoji": "🌟"}), http.StatusConflict, "too_many_reactions")

	// Pins: any member pins; the channel lists them.
	var pinned struct {
		Message richMessage `json:"message"`
	}
	emp.must(http.StatusOK, http.MethodPut, base+msg.ID+"/pin", nil).decode(t, &pinned)
	if pinned.Message.Pinned == nil || pinned.Message.Pinned.By.ID != empID {
		t.Fatalf("pinned = %+v", pinned.Message)
	}
	var pins struct {
		Messages []richMessage `json:"messages"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/channels/"+general+"/pins", nil).decode(t, &pins)
	if len(pins.Messages) != 1 || pins.Messages[0].ID != msg.ID {
		t.Fatalf("pins = %+v", pins)
	}
	owner.must(http.StatusOK, http.MethodDelete, base+msg.ID+"/pin", nil)
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/channels/"+general+"/pins", nil).decode(t, &pins)
	if len(pins.Messages) != 0 {
		t.Fatalf("pins after unpin = %+v", pins)
	}

	// Only channel members react or pin.
	quiet := owner.createChannel(orgID, map[string]any{"name": "sessiz", "visibility": "public"})
	q := owner.postRich(orgID, quiet.ID, map[string]any{"body": "x"})
	qBase := "/api/v1/orgs/" + orgID + "/channels/" + quiet.ID + "/messages/" + q.ID
	expectError(t, emp.do(http.MethodPost, qBase+"/reactions", map[string]string{"emoji": "👍"}), http.StatusForbidden, "not_channel_member")
	expectError(t, emp.do(http.MethodPut, qBase+"/pin", nil), http.StatusForbidden, "not_channel_member")
}

func TestThreadAndReactionEvents(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	general := owner.channels(orgID)[0].ID
	root := owner.postRich(orgID, general, map[string]any{"body": "Kök"})

	events := owner.events()
	emp.postRich(orgID, general, map[string]any{"body": "Yanıt", "parentId": root.ID})
	var created struct {
		Message richMessage `json:"message"`
	}
	if err := json.Unmarshal(events.next("message.created").Data, &created); err != nil || created.Message.ParentID == nil {
		t.Fatalf("reply event = %+v, %v", created, err)
	}
	var updated struct {
		Message richMessage `json:"message"`
	}
	if err := json.Unmarshal(events.next("message.updated").Data, &updated); err != nil ||
		updated.Message.ID != root.ID || updated.Message.Thread == nil || updated.Message.Thread.ReplyCount != 1 {
		t.Fatalf("root update = %+v, %v", updated, err)
	}

	emp.must(http.StatusOK, http.MethodPost, "/api/v1/orgs/"+orgID+"/channels/"+general+"/messages/"+root.ID+"/reactions",
		map[string]string{"emoji": "🎉"})
	var reactions struct {
		MessageID string `json:"messageId"`
		Reactions []struct {
			Emoji string `json:"emoji"`
		} `json:"reactions"`
	}
	if err := json.Unmarshal(events.next("message.reactions").Data, &reactions); err != nil ||
		reactions.MessageID != root.ID || len(reactions.Reactions) != 1 || reactions.Reactions[0].Emoji != "🎉" {
		t.Fatalf("reactions event = %+v, %v", reactions, err)
	}
}
