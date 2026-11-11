// Package realtime delivers live events to signed-in clients over Server-Sent Events
// (ADR-0008). Events are addressed to users; the publisher decides who may receive
// them at publish time, so the hub holds no authorization state of its own.
package realtime

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"fudislte/api/internal/auth"
	"fudislte/api/internal/httpx"
)

// Event is one notification. Data is encoded as JSON.
type Event struct {
	Type string
	Data any
}

// Publisher hands events to the connected sessions of the given users.
type Publisher interface {
	Publish(userIDs []uuid.UUID, ev Event)
}

const (
	bufferSize     = 64
	heartbeatEvery = 25 * time.Second
	writeTimeout   = 10 * time.Second
	// maxStreamAge ends long-lived streams so the browser reconnects and its session is
	// checked again.
	maxStreamAge = 30 * time.Minute
)

type subscriber struct {
	id        uuid.UUID // the connection ID clients use to report activity
	userID    uuid.UUID
	sessionID uuid.UUID
	active    bool
	ch        chan []byte
	done      chan struct{}
}

// Hub is the in-process event broker for a single API node. It also derives presence
// from the open streams (presence.go).
type Hub struct {
	mu     sync.Mutex
	subs   map[uuid.UUID]map[*subscriber]struct{} // by user
	closed bool

	grace         time.Duration
	states        map[uuid.UUID]State       // last reported presence, by user
	offlineTimers map[uuid.UUID]*time.Timer // users whose last stream closed
	changes       chan presenceChange
	onPresence    func(changes map[uuid.UUID]State)
}

type HubOption func(*Hub)

// WithPresenceGrace sets how long a person stays online after their last stream closes.
func WithPresenceGrace(d time.Duration) HubOption {
	return func(h *Hub) { h.grace = d }
}

func NewHub(opts ...HubOption) *Hub {
	h := &Hub{
		subs:          make(map[uuid.UUID]map[*subscriber]struct{}),
		grace:         defaultPresenceGrace,
		states:        make(map[uuid.UUID]State),
		offlineTimers: make(map[uuid.UUID]*time.Timer),
		changes:       make(chan presenceChange, 1024),
	}
	for _, opt := range opts {
		opt(h)
	}
	go h.dispatchPresence()
	return h
}

// Publish queues ev for every open stream of userIDs. A stream whose buffer is full is
// closed instead of blocking the publisher; its client reconnects and refetches.
func (h *Hub) Publish(userIDs []uuid.UUID, ev Event) {
	data, err := json.Marshal(ev.Data)
	if err != nil {
		slog.Error("realtime: encode event", "type", ev.Type, "error", err)
		return
	}
	msg := fmt.Appendf(nil, "event: %s\ndata: %s\n\n", ev.Type, data)
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, id := range userIDs {
		for sub := range h.subs[id] {
			select {
			case sub.ch <- msg:
			default:
				h.removeLocked(sub)
			}
		}
	}
}

// CloseSessions ends the streams of the given sessions, e.g. after sign-out.
func (h *Hub) CloseSessions(sessionIDs ...uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, subs := range h.subs {
		for sub := range subs {
			for _, id := range sessionIDs {
				if sub.sessionID == id {
					h.removeLocked(sub)
					break
				}
			}
		}
	}
}

// Close ends every stream and rejects new ones; call it when the server shuts down.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for _, subs := range h.subs {
		for sub := range subs {
			h.removeLocked(sub)
		}
	}
	for _, t := range h.offlineTimers {
		t.Stop()
	}
	close(h.changes)
}

func (h *Hub) subscribe(userID, sessionID uuid.UUID) *subscriber {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	sub := &subscriber{
		id:        uuid.New(),
		userID:    userID,
		sessionID: sessionID,
		active:    true,
		ch:        make(chan []byte, bufferSize),
		done:      make(chan struct{}),
	}
	if h.subs[userID] == nil {
		h.subs[userID] = make(map[*subscriber]struct{})
	}
	h.subs[userID][sub] = struct{}{}
	h.updatePresenceLocked(userID)
	return sub
}

func (h *Hub) unsubscribe(sub *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeLocked(sub)
}

func (h *Hub) removeLocked(sub *subscriber) {
	subs, ok := h.subs[sub.userID]
	if !ok {
		return
	}
	if _, ok := subs[sub]; !ok {
		return
	}
	delete(subs, sub)
	if len(subs) == 0 {
		delete(h.subs, sub.userID)
	}
	close(sub.done)
	if !h.closed {
		h.updatePresenceLocked(sub.userID)
	}
}

// Stream serves the caller's event stream. The first event, "ready", is sent once the
// stream is registered, so clients know that later changes will reach them.
func (h *Hub) Stream(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustIdentity(r.Context())
	if h.streams(id.User.ID) >= maxStreamsPerUser {
		return errTooManyStreams
	}
	sub := h.subscribe(id.User.ID, id.SessionID)
	if sub == nil {
		return errShuttingDown
	}
	defer h.unsubscribe(sub)

	// Streams outlive the server's read and write timeouts: clear the read deadline and
	// give every write its own.
	rc := http.NewResponseController(w)
	if err := rc.SetReadDeadline(time.Time{}); err != nil {
		slog.WarnContext(r.Context(), "realtime: cannot extend read deadline", "error", err)
	}
	write := func(b []byte) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(writeTimeout))
		if _, err := w.Write(b); err != nil {
			return false
		}
		return rc.Flush() == nil
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// The connection ID lets the client report when this window is idle (presence.go).
	if !write(fmt.Appendf(nil, "retry: 3000\nevent: ready\ndata: {\"connectionId\":%q}\n\n", sub.id)) {
		return nil
	}

	heartbeat := time.NewTicker(heartbeatEvery)
	defer heartbeat.Stop()
	maxAge := time.NewTimer(maxStreamAge)
	defer maxAge.Stop()
	for {
		select {
		case msg := <-sub.ch:
			if !write(msg) {
				return nil
			}
		case <-heartbeat.C:
			if !write([]byte(": ping\n\n")) {
				return nil
			}
		case <-sub.done:
			return nil
		case <-maxAge.C:
			return nil
		case <-r.Context().Done():
			return nil
		}
	}
}

// maxStreamsPerUser bounds the live connections one account holds (each costs a goroutine
// and a buffer); people rarely have more than a few windows and devices open.
const maxStreamsPerUser = 32

var errTooManyStreams = httpx.NewError(http.StatusTooManyRequests, "too_many_streams", "Too many windows are open for this account. Close some and try again.")

func (h *Hub) streams(userID uuid.UUID) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs[userID])
}

var errShuttingDown = httpx.NewError(http.StatusServiceUnavailable, "shutting_down", "The server is restarting. Try again in a moment.")
