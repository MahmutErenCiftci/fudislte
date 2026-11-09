package realtime

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func closed(sub *subscriber) bool {
	select {
	case <-sub.done:
		return true
	default:
		return false
	}
}

func TestPublishReachesOnlyAddressedUsers(t *testing.T) {
	h := NewHub()
	alice, bob := uuid.New(), uuid.New()
	a, b := h.subscribe(alice, uuid.New()), h.subscribe(bob, uuid.New())
	h.Publish([]uuid.UUID{alice}, Event{Type: "message.created", Data: map[string]string{"body": "hi"}})
	if got := string(<-a.ch); got != "event: message.created\ndata: {\"body\":\"hi\"}\n\n" {
		t.Fatalf("frame = %q", got)
	}
	if len(b.ch) != 0 {
		t.Fatal("bob received alice's event")
	}
}

func TestSlowSubscriberIsDropped(t *testing.T) {
	h := NewHub()
	user := uuid.New()
	slow := h.subscribe(user, uuid.New())
	for i := 0; i <= bufferSize; i++ {
		h.Publish([]uuid.UUID{user}, Event{Type: "tick", Data: i})
	}
	if !closed(slow) {
		t.Fatal("subscriber with a full buffer was kept")
	}
	h.Publish([]uuid.UUID{user}, Event{Type: "tick", Data: 0}) // no panic on removed subscriber
}

func TestPresenceFollowsStreams(t *testing.T) {
	h := NewHub(WithPresenceGrace(50 * time.Millisecond))
	defer h.Close()
	changes := make(chan State, 10)
	h.OnPresence(func(batch map[uuid.UUID]State) {
		for _, s := range batch {
			changes <- s
		}
	})
	expect := func(want State) {
		t.Helper()
		select {
		case got := <-changes:
			if got != want {
				t.Fatalf("state %s, want %s", got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("no change to %s", want)
		}
	}
	none := func() {
		t.Helper()
		select {
		case got := <-changes:
			t.Fatalf("unexpected change to %s", got)
		case <-time.After(100 * time.Millisecond):
		}
	}

	user := uuid.New()
	a := h.subscribe(user, uuid.New())
	expect(Online)
	h.SetActive(user, a.id, false)
	expect(Away)
	b := h.subscribe(user, uuid.New()) // a second, active window
	expect(Online)
	h.unsubscribe(b)
	expect(Away)

	// A reload within the grace period is not reported.
	h.unsubscribe(a)
	c := h.subscribe(user, uuid.New())
	expect(Online)
	h.unsubscribe(c)
	expect(Offline)
	none()
	if got := h.Presence([]uuid.UUID{user})[user]; got != Offline {
		t.Fatalf("Presence = %s", got)
	}
}

func TestCloseSessionsAndClose(t *testing.T) {
	h := NewHub()
	user, session := uuid.New(), uuid.New()
	a, b := h.subscribe(user, session), h.subscribe(user, uuid.New())
	h.CloseSessions(session)
	if !closed(a) || closed(b) {
		t.Fatal("CloseSessions must close exactly the session's streams")
	}
	h.Close()
	if !closed(b) || h.subscribe(user, session) != nil {
		t.Fatal("Close must end all streams and refuse new ones")
	}
}

func TestPresenceCoalescesBursts(t *testing.T) {
	h := NewHub()
	defer h.Close()
	release := make(chan struct{})
	batches := make(chan map[uuid.UUID]State, 10)
	h.OnPresence(func(batch map[uuid.UUID]State) {
		batches <- batch
		<-release
	})

	h.subscribe(uuid.New(), uuid.New())
	first := <-batches // the callback now blocks
	users := make([]uuid.UUID, 50)
	for i := range users {
		users[i] = uuid.New()
		s := h.subscribe(users[i], uuid.New())
		h.SetActive(users[i], s.id, false) // online, then away: only away is reported
	}
	close(release)
	second := <-batches
	if len(first) != 1 || len(second) != len(users) {
		t.Fatalf("batch sizes %d and %d, want 1 and %d", len(first), len(second), len(users))
	}
	for _, id := range users {
		if second[id] != Away {
			t.Fatalf("user state %q, want away", second[id])
		}
	}
}
