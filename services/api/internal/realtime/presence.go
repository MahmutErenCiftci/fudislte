package realtime

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"fudislte/api/internal/auth"
	"fudislte/api/internal/httpx"
)

// State is a person's presence, derived from their open event streams.
type State string

const (
	Online  State = "online"
	Away    State = "away" // every open stream reports the person idle
	Offline State = "offline"
)

// defaultPresenceGrace hides reloads and brief network drops: a person whose last
// stream closes stays online for this long.
const defaultPresenceGrace = 15 * time.Second

type presenceChange struct {
	userID uuid.UUID
	state  State
}

// OnPresence registers the function told about presence changes, with each changed
// user's latest state. Calls happen one at a time, outside the hub's lock; changes that
// arrive while a call runs are merged into the next one, so a burst (a restart, everyone
// reconnecting) costs a few calls instead of one per change.
func (h *Hub) OnPresence(fn func(changes map[uuid.UUID]State)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onPresence = fn
}

func (h *Hub) dispatchPresence() {
	for c := range h.changes {
		batch := map[uuid.UUID]State{c.userID: c.state}
	drain:
		for {
			select {
			case c, ok := <-h.changes:
				if !ok {
					break drain
				}
				batch[c.userID] = c.state
			default:
				break drain
			}
		}
		h.mu.Lock()
		fn := h.onPresence
		h.mu.Unlock()
		if fn != nil {
			fn(batch)
		}
	}
}

// Presence returns the current state of each user.
func (h *Hub) Presence(userIDs []uuid.UUID) map[uuid.UUID]State {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make(map[uuid.UUID]State, len(userIDs))
	for _, id := range userIDs {
		if s, ok := h.states[id]; ok {
			out[id] = s
		} else {
			out[id] = Offline
		}
	}
	return out
}

// SetActive records whether the window behind one of userID's streams is in use. It
// reports false when no such stream exists.
func (h *Hub) SetActive(userID, connectionID uuid.UUID, active bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subs[userID] {
		if sub.id == connectionID {
			sub.active = active
			h.updatePresenceLocked(userID)
			return true
		}
	}
	return false
}

// updatePresenceLocked recomputes userID's state after their streams changed.
func (h *Hub) updatePresenceLocked(userID uuid.UUID) {
	subs := h.subs[userID]
	if len(subs) == 0 {
		if _, waiting := h.offlineTimers[userID]; waiting {
			return
		}
		h.offlineTimers[userID] = time.AfterFunc(h.grace, func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			delete(h.offlineTimers, userID)
			if len(h.subs[userID]) == 0 && !h.closed {
				h.setStateLocked(userID, Offline)
			}
		})
		return
	}
	if t, ok := h.offlineTimers[userID]; ok {
		t.Stop()
		delete(h.offlineTimers, userID)
	}
	state := Away
	for sub := range subs {
		if sub.active {
			state = Online
			break
		}
	}
	h.setStateLocked(userID, state)
}

func (h *Hub) setStateLocked(userID uuid.UUID, state State) {
	if h.closed || h.states[userID] == state || (state == Offline && h.states[userID] == "") {
		return
	}
	if state == Offline {
		delete(h.states, userID)
	} else {
		h.states[userID] = state
	}
	select {
	case h.changes <- presenceChange{userID, state}:
	default:
		slog.Warn("realtime: presence queue full; dropping a change", "user", userID)
	}
}

// ReportActivity handles POST /api/v1/presence: {"connectionId", "active"} from the
// caller's own stream.
func (h *Hub) ReportActivity(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustIdentity(r.Context())
	var in struct {
		ConnectionID uuid.UUID `json:"connectionId"`
		Active       bool      `json:"active"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if !h.SetActive(id.User.ID, in.ConnectionID, in.Active) {
		return httpx.ErrNotFound
	}
	httpx.NoContent(w)
	return nil
}
