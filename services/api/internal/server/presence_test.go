package server_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

type presenceEntry struct {
	UserID string `json:"userId"`
	State  string `json:"state"`
	Status *struct {
		Kind string `json:"kind"`
		Text string `json:"text"`
		Mute *bool  `json:"mute"`
	} `json:"status"`
}

func presenceOf(t *testing.T, c *client, orgID, userID string) presenceEntry {
	t.Helper()
	var out struct {
		Presence []presenceEntry `json:"presence"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/presence", nil).decode(t, &out)
	for _, e := range out.Presence {
		if e.UserID == userID {
			return e
		}
	}
	t.Fatalf("no presence for %s in %+v", userID, out.Presence)
	return presenceEntry{}
}

// presenceIs matches presence.changed events for userID in state.
func presenceIs(userID, state string) func(json.RawMessage) bool {
	return func(data json.RawMessage) bool {
		var e presenceEntry
		return json.Unmarshal(data, &e) == nil && e.UserID == userID && e.State == state
	}
}

func TestPresenceAndStatus(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	guest, _ := ts.join(owner, orgID, "guest@example.com", "guest")

	if got := presenceOf(t, owner, orgID, empID); got.State != "offline" || got.Status != nil {
		t.Fatalf("before connecting = %+v", got)
	}
	watch := owner.allEvents()

	// Online with an open stream, away when every stream is idle.
	stream := emp.allEvents()
	watch.waitFor("presence.changed", presenceIs(empID, "online"))
	if got := presenceOf(t, owner, orgID, empID); got.State != "online" {
		t.Fatalf("connected = %+v", got)
	}
	emp.must(http.StatusNoContent, http.MethodPost, "/api/v1/presence", map[string]any{"connectionId": stream.connectionID, "active": false})
	watch.waitFor("presence.changed", presenceIs(empID, "away"))
	emp.must(http.StatusNoContent, http.MethodPost, "/api/v1/presence", map[string]any{"connectionId": stream.connectionID, "active": true})
	watch.waitFor("presence.changed", presenceIs(empID, "online"))
	expectError(t, owner.do(http.MethodPost, "/api/v1/presence", map[string]any{"connectionId": stream.connectionID, "active": false}),
		http.StatusNotFound, "not_found")

	// Status: others see it without the private mute flag.
	until := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	emp.must(http.StatusOK, http.MethodPut, "/api/v1/me/status", map[string]any{"kind": "meeting", "text": "Sprint planlama", "expiresAt": until, "mute": true})
	ev := watch.waitFor("presence.changed", func(data json.RawMessage) bool {
		var e presenceEntry
		return json.Unmarshal(data, &e) == nil && e.UserID == empID && e.Status != nil
	})
	var seen presenceEntry
	_ = json.Unmarshal(ev.Data, &seen)
	if seen.Status.Kind != "meeting" || seen.Status.Text != "Sprint planlama" || seen.Status.Mute != nil {
		t.Fatalf("status event = %s", ev.Data)
	}
	var mine struct {
		User struct {
			Status *struct {
				Kind string `json:"kind"`
				Mute bool   `json:"mute"`
			} `json:"status"`
		} `json:"user"`
	}
	emp.must(http.StatusOK, http.MethodGet, "/api/v1/me", nil).decode(t, &mine)
	if mine.User.Status == nil || mine.User.Status.Kind != "meeting" || !mine.User.Status.Mute {
		t.Fatalf("own status = %+v", mine.User.Status)
	}
	if got := presenceOf(t, owner, orgID, empID); got.Status == nil || got.Status.Kind != "meeting" {
		t.Fatalf("listed status = %+v", got)
	}
	for _, bad := range []map[string]any{
		{"kind": "sleeping"},
		{"kind": "custom", "text": "  "},
		{"kind": "focus", "expiresAt": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)},
	} {
		expectError(t, emp.do(http.MethodPut, "/api/v1/me/status", bad), http.StatusUnprocessableEntity, "validation_failed")
	}
	emp.must(http.StatusNoContent, http.MethodDelete, "/api/v1/me/status", nil)
	if got := presenceOf(t, owner, orgID, empID); got.Status != nil {
		t.Fatalf("cleared status = %+v", got)
	}

	// Members who cannot see the directory cannot see presence either.
	expectError(t, guest.do(http.MethodGet, "/api/v1/orgs/"+orgID+"/presence", nil), http.StatusForbidden, "forbidden")

	// Offline once the last stream has been closed for the grace period.
	stream.cancel()
	watch.waitFor("presence.changed", presenceIs(empID, "offline"))
}

type notification struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Actor struct {
		ID string `json:"id"`
	} `json:"actor"`
	Message struct {
		ID string `json:"id"`
	} `json:"message"`
	Read bool `json:"read"`
}

func (c *client) notifications(orgID string) ([]notification, int) {
	c.t.Helper()
	var out struct {
		Notifications []notification `json:"notifications"`
		UnreadCount   int            `json:"unreadCount"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/notifications", nil).decode(c.t, &out)
	return out.Notifications, out.UnreadCount
}

func TestTypingAndNotifications(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")
	ownerID := owner.me().User.ID
	general := owner.channels(orgID)[0].ID
	base := "/api/v1/orgs/" + orgID + "/channels/"

	// Typing reaches the other members only, and is never stored.
	ownerEvents, empEvents := owner.allEvents(), emp.allEvents()
	emp.must(http.StatusNoContent, http.MethodPost, base+general+"/typing", map[string]any{})
	ownerEvents.waitFor("typing", func(data json.RawMessage) bool {
		var e struct {
			User struct {
				ID string `json:"id"`
			} `json:"user"`
		}
		return json.Unmarshal(data, &e) == nil && e.User.ID == empID
	})

	// A mention notifies the person mentioned.
	root := owner.postRich(orgID, general, map[string]any{"body": "<@" + empID + "> sürüm notlarına bakar mısın?"})
	ev := empEvents.waitFor("notification.created", func(json.RawMessage) bool { return true })
	var pushed struct {
		Notification notification `json:"notification"`
	}
	if err := json.Unmarshal(ev.Data, &pushed); err != nil || pushed.Notification.Kind != "mention" || pushed.Notification.Actor.ID != ownerID {
		t.Fatalf("pushed = %s", ev.Data)
	}
	if list, unread := emp.notifications(orgID); len(list) != 1 || unread != 1 || list[0].Message.ID != root.ID {
		t.Fatalf("emp notifications = %+v, %d", list, unread)
	}
	if list, _ := dev.notifications(orgID); len(list) != 0 {
		t.Fatalf("dev was not mentioned: %+v", list)
	}

	// Replies notify everyone already in the thread, except the author; a mention wins.
	emp.postRich(orgID, general, map[string]any{"body": "Bakıyorum.", "parentId": root.ID})
	dev.postRich(orgID, general, map[string]any{"body": "Ben de <@" + ownerID + ">", "parentId": root.ID})
	ownerList, ownerUnread := owner.notifications(orgID)
	if ownerUnread != 2 || ownerList[0].Kind != "mention" || ownerList[1].Kind != "reply" {
		t.Fatalf("owner notifications = %+v", ownerList)
	}
	empList, _ := emp.notifications(orgID)
	if len(empList) != 2 || empList[0].Kind != "reply" || empList[0].Actor.ID != devID {
		t.Fatalf("emp notifications = %+v", empList)
	}
	if list, _ := dev.notifications(orgID); len(list) != 0 {
		t.Fatalf("authors are not notified: %+v", list)
	}

	// Only channel members are notified; a later edit notifies newly mentioned people.
	secret := owner.createChannel(orgID, map[string]any{"name": "gizli", "visibility": "private", "memberIds": []string{empID}})
	msg := owner.postRich(orgID, secret.ID, map[string]any{"body": "<@" + devID + "> bunu göremez"})
	if list, _ := dev.notifications(orgID); len(list) != 0 {
		t.Fatalf("non-member notified: %+v", list)
	}
	owner.must(http.StatusOK, http.MethodPatch, base+secret.ID+"/messages/"+msg.ID, map[string]string{"body": "<@" + empID + "> sen bak"})
	if _, unread := emp.notifications(orgID); unread != 3 {
		t.Fatalf("emp unread after edit = %d", unread)
	}

	// Reading: by ID, by opening the channel, or all at once.
	var read struct {
		UnreadCount int `json:"unreadCount"`
	}
	emp.must(http.StatusOK, http.MethodPost, "/api/v1/orgs/"+orgID+"/notifications/read", map[string]any{"ids": []string{empList[0].ID}}).decode(t, &read)
	if read.UnreadCount != 2 {
		t.Fatalf("after reading one = %d", read.UnreadCount)
	}
	emp.must(http.StatusNoContent, http.MethodPost, base+secret.ID+"/read", map[string]string{"messageId": msg.ID})
	if _, unread := emp.notifications(orgID); unread != 1 {
		t.Fatalf("after opening the channel = %d", unread)
	}
	emp.must(http.StatusOK, http.MethodPost, "/api/v1/orgs/"+orgID+"/notifications/read", map[string]any{"all": true}).decode(t, &read)
	if read.UnreadCount != 0 {
		t.Fatalf("after reading all = %d", read.UnreadCount)
	}
	empEvents.waitFor("notification.read", func(json.RawMessage) bool { return true })
}
