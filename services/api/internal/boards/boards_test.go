package boards

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHigherVersionWinsAndLowerNonceBreaksTies(t *testing.T) {
	cur := header{ID: "a", Version: 5, VersionNonce: 500}
	for _, c := range []struct {
		in   header
		want bool
	}{
		{header{Version: 6, VersionNonce: 900}, true},
		{header{Version: 4, VersionNonce: 1}, false},
		{header{Version: 5, VersionNonce: 499}, true},
		{header{Version: 5, VersionNonce: 501}, false},
		{header{Version: 5, VersionNonce: 500}, false}, // the same copy changes nothing
	} {
		if got := wins(c.in, cur); got != c.want {
			t.Errorf("wins(%+v, %+v) = %v, want %v", c.in, cur, got, c.want)
		}
	}
}

func raw(id, typ string, version, nonce int64) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"id":%q,"type":%q,"version":%d,"versionNonce":%d,"isDeleted":false,"x":1}`, id, typ, version, nonce))
}

func TestParseElements(t *testing.T) {
	got, err := parseElements([]json.RawMessage{raw("a", "rectangle", 2, 9), raw("a", "rectangle", 3, 9), raw("a", "rectangle", 3, 4), raw("b", "text", 1, 1)})
	if err != nil || len(got) != 2 || got[0].Version != 3 || got[0].VersionNonce != 4 || got[1].ID != "b" {
		t.Fatalf("parseElements kept %+v, %v; want a@3/4 and b", got, err)
	}
	for name, batch := range map[string][]json.RawMessage{
		"empty":       {},
		"image":       {raw("a", "image", 1, 1)},
		"embeddable":  {raw("a", "embeddable", 1, 1)},
		"bad id":      {raw("a/b", "rectangle", 1, 1)},
		"version 0":   {raw("a", "rectangle", 0, 1)},
		"not object":  {json.RawMessage(`[1]`)},
		"too large":   {json.RawMessage(`{"id":"a","type":"freedraw","version":1,"points":"` + string(make([]byte, maxElementBytes)) + `"}`)},
		"over 500":    make([]json.RawMessage, maxBatch+1),
		"missing ids": {json.RawMessage(`{"type":"rectangle","version":1}`)},
	} {
		if name == "over 500" {
			for i := range batch {
				batch[i] = raw(fmt.Sprint("e", i), "line", 1, 1)
			}
		}
		if _, err := parseElements(batch); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestViewerRegistry(t *testing.T) {
	r := newRegistry(30 * time.Second)
	board := uuid.New()
	sc := scope{orgID: uuid.New()}
	alex, dana := Person{ID: uuid.New(), DisplayName: "Alex"}, Person{ID: uuid.New(), DisplayName: "Dana"}
	t0 := time.Now()

	if !r.heartbeat(sc, board, "alex-tab-1", alex, t0) {
		t.Fatal("first window of a person changes the list")
	}
	if r.heartbeat(sc, board, "alex-tab-2", alex, t0.Add(time.Second)) {
		t.Fatal("a second window of the same person does not")
	}
	if !r.heartbeat(sc, board, "dana-tab-1", dana, t0.Add(2*time.Second)) {
		t.Fatal("another person does")
	}
	// Someone using another person's window ID gets an entry of their own.
	if r.heartbeat(sc, board, "alex-tab-1", dana, t0.Add(2*time.Second)) || len(r.users(board)) != 2 {
		t.Fatalf("users = %v", r.users(board))
	}
	if r.leave(board, "alex-tab-1", dana.ID) {
		t.Fatal("Dana still has a window open")
	}
	if list := r.list(board); len(list) != 2 || list[0].User.ID != alex.ID || !list[0].Since.Equal(t0) {
		t.Fatalf("list = %+v", list)
	}
	if r.leave(board, "alex-tab-1", alex.ID) {
		t.Fatal("Alex still has a second window")
	}

	// Windows that stop sending heartbeats drop out after the TTL.
	r.heartbeat(sc, board, "dana-tab-1", dana, t0.Add(25*time.Second))
	changed := r.expire(t0.Add(35 * time.Second))
	if _, ok := changed[board]; !ok || len(r.users(board)) != 1 || r.users(board)[0] != dana.ID {
		t.Fatalf("after expiry: changed %v, users %v", changed, r.users(board))
	}
	if changed := r.expire(t0.Add(60 * time.Second)); len(changed) != 1 || len(r.users(board)) != 0 {
		t.Fatalf("after Dana's expiry: changed %v, users %v", changed, r.users(board))
	}
}
