package server_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

type conversation struct {
	channel
	Kind         string `json:"kind"`
	Participants []struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
	} `json:"participants"`
	LastMessage *message `json:"lastMessage"`
}

func (c *client) openConversation(orgID string, want int, userIDs ...string) conversation {
	c.t.Helper()
	var out struct {
		Conversation conversation `json:"conversation"`
	}
	if userIDs == nil {
		userIDs = []string{}
	}
	c.must(want, http.MethodPost, "/api/v1/orgs/"+orgID+"/conversations", map[string]any{"userIds": userIDs}).decode(c.t, &out)
	return out.Conversation
}

func (c *client) conversations(orgID string) []conversation {
	c.t.Helper()
	var out struct {
		Conversations []conversation `json:"conversations"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/conversations", nil).decode(c.t, &out)
	return out.Conversations
}

func TestDirectMessages(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")
	base := "/api/v1/orgs/" + orgID + "/channels/"

	// Opening is find-or-create, in any order of people.
	dm := emp.openConversation(orgID, http.StatusCreated, devID)
	if dm.Kind != "direct" || dm.Name != "" || dm.Visibility != "private" || len(dm.Participants) != 2 || !dm.Joined {
		t.Fatalf("conversation = %+v", dm)
	}
	if again := dev.openConversation(orgID, http.StatusOK, empID, devID); again.ID != dm.ID {
		t.Fatalf("second open created %s, want %s", again.ID, dm.ID)
	}
	if find(emp.channels(orgID), "") != nil || len(emp.channelList(orgID, "/channels/browse")) != 1 {
		t.Fatal("direct conversations must not appear among channels")
	}

	// It reaches the other person's list with the first message.
	if got := owner.conversations(orgID); len(got) != 0 {
		t.Fatalf("outsider conversations = %+v", got)
	}
	fresh := emp.openConversation(orgID, http.StatusCreated, devID, ownerID(t, owner))
	if got := dev.conversations(orgID); len(got) != 0 {
		t.Fatalf("dev conversations before any message = %+v, want none", got)
	}
	if got := emp.conversations(orgID); len(got) != 2 {
		t.Fatalf("the opener sees their empty conversations: %+v", got)
	}
	emp.post(orgID, dm.ID, "Selam, PR'a bakabilir misin?")
	list := dev.conversations(orgID)
	if len(list) != 1 || list[0].UnreadCount != 1 || list[0].LastMessage == nil || list[0].LastMessage.Body != "Selam, PR'a bakabilir misin?" {
		t.Fatalf("dev conversations = %+v", list)
	}
	emp.post(orgID, fresh.ID, "Grup mesajı")
	if list = dev.conversations(orgID); len(list) != 2 || list[0].ID != fresh.ID {
		t.Fatalf("newest activity must come first: %+v", list)
	}

	// Outsiders cannot see or reach it; membership is fixed.
	for _, path := range []string{"", "/messages", "/members"} {
		expectError(t, owner.do(http.MethodGet, base+dm.ID+path, nil), http.StatusNotFound, "not_found")
	}
	expectError(t, owner.do(http.MethodPost, base+dm.ID+"/messages", map[string]string{"body": "x"}), http.StatusNotFound, "not_found")
	expectError(t, emp.do(http.MethodPost, base+dm.ID+"/leave", nil), http.StatusConflict, "direct_conversation")
	expectError(t, emp.do(http.MethodPost, base+dm.ID+"/members", map[string]any{"userIds": []string{ownerID(t, owner)}}),
		http.StatusConflict, "direct_conversation")
	expectError(t, emp.do(http.MethodPatch, base+dm.ID, map[string]string{"name": "x"}), http.StatusConflict, "direct_conversation")

	// Moderators cannot delete messages in conversations they are part of.
	ownerDM := owner.openConversation(orgID, http.StatusCreated, empID)
	msg := emp.post(orgID, ownerDM.ID, "Özel not")
	expectError(t, owner.do(http.MethodDelete, base+ownerDM.ID+"/messages/"+msg.ID, nil), http.StatusForbidden, "forbidden")

	// Notes to self, the size limit and unknown people.
	if self := emp.openConversation(orgID, http.StatusCreated); len(self.Participants) != 1 {
		t.Fatalf("notes to self = %+v", self)
	}
	many := []string{}
	for i := range 9 {
		many = append(many, "0190a8b4-0000-7000-8000-00000000000"+string(rune('0'+i)))
	}
	expectError(t, emp.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/conversations", map[string]any{"userIds": many}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, emp.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/conversations", map[string]any{"userIds": many[:1]}),
		http.StatusUnprocessableEntity, "validation_failed")
}

func ownerID(t *testing.T, owner *client) string {
	t.Helper()
	return owner.me().User.ID
}

func TestGuestsMessageOnlyPeopleTheyWorkWith(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	guest, guestID := ts.join(owner, orgID, "guest@example.com", "guest")
	_, devID := ts.join(owner, orgID, "dev@example.com", "developer")

	expectError(t, guest.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/conversations", map[string]any{"userIds": []string{devID}}),
		http.StatusForbidden, "forbidden")
	owner.createChannel(orgID, map[string]any{"name": "proje", "visibility": "private", "memberIds": []string{guestID, devID}})
	guest.openConversation(orgID, http.StatusCreated, devID)
}

func TestDirectMessageEventsAndWorkspaceRemoval(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")

	dm := emp.openConversation(orgID, http.StatusCreated, devID)
	devEvents, ownerEvents := dev.events(), owner.events()
	emp.post(orgID, dm.ID, "Merhaba")
	var created struct {
		ChannelID string `json:"channelId"`
	}
	if err := json.Unmarshal(devEvents.next("message.created").Data, &created); err != nil || created.ChannelID != dm.ID {
		t.Fatalf("event = %+v, %v", created, err)
	}
	ownerEvents.quiet()

	// Leaving the workspace ends delivery; the conversation stays for the other person.
	owner.must(http.StatusNoContent, http.MethodDelete, "/api/v1/orgs/"+orgID+"/members/"+devID, nil)
	emp.post(orgID, dm.ID, "Orada mısın?")
	devEvents.quiet()
	if list := emp.conversations(orgID); len(list) != 1 || len(list[0].Participants) != 2 {
		t.Fatalf("conversation after removal = %+v", list)
	}
	expectError(t, emp.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/conversations", map[string]any{"userIds": []string{devID}}),
		http.StatusUnprocessableEntity, "validation_failed")
}
