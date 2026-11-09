package boards

import (
	"context"
	"math"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"fudislte/api/internal/httpx"
	"fudislte/api/internal/realtime"
)

// Who is viewing a board, and their cursors. Like typing indicators this is ephemeral
// and in memory: each open board window sends a heartbeat about every 10 seconds and
// drops out 30 seconds after the last one. Scene events and cursors go only to current
// viewers who may still see the board (checked at every send); cursors are relayed and
// never stored.

const viewerTTL = 30 * time.Second

var now = time.Now

// Viewer is someone with the board open.
type Viewer struct {
	User  Person    `json:"user"`
	Since time.Time `json:"since"`
}

type client struct {
	user  Person
	since time.Time
	seen  time.Time
}

type boardViewers struct {
	scope scope
	// clients is keyed by user and window, so nobody can replace someone else's entry
	// with a window ID seen in an event.
	clients map[clientKey]*client
}

type clientKey struct {
	userID   uuid.UUID
	clientID string
}

// registry tracks the open board windows of this API process.
type registry struct {
	mu     sync.Mutex
	ttl    time.Duration
	boards map[uuid.UUID]*boardViewers
}

func newRegistry(ttl time.Duration) *registry {
	return &registry{ttl: ttl, boards: map[uuid.UUID]*boardViewers{}}
}

// heartbeat records that clientID shows the board; it reports whether the list of
// people viewing changed.
func (r *registry) heartbeat(sc scope, boardID uuid.UUID, clientID string, user Person, at time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	bv := r.boards[boardID]
	if bv == nil {
		bv = &boardViewers{scope: sc, clients: map[clientKey]*client{}}
		r.boards[boardID] = bv
	}
	key := clientKey{user.ID, clientID}
	if c := bv.clients[key]; c != nil {
		c.seen = at
		return false
	}
	before := bv.hasUser(user.ID)
	bv.clients[key] = &client{user: user, since: at, seen: at}
	return !before
}

// leave forgets a window of userID; it reports whether userID stopped viewing.
func (r *registry) leave(boardID uuid.UUID, clientID string, userID uuid.UUID) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	bv := r.boards[boardID]
	if bv == nil {
		return false
	}
	key := clientKey{userID, clientID}
	if bv.clients[key] == nil {
		return false
	}
	delete(bv.clients, key)
	if len(bv.clients) == 0 {
		delete(r.boards, boardID)
	}
	return !bv.hasUser(userID)
}

func (bv *boardViewers) hasUser(id uuid.UUID) bool {
	for _, c := range bv.clients {
		if c.user.ID == id {
			return true
		}
	}
	return false
}

// users returns everyone viewing the board.
func (r *registry) users(boardID uuid.UUID) []uuid.UUID {
	r.mu.Lock()
	defer r.mu.Unlock()
	var ids []uuid.UUID
	if bv := r.boards[boardID]; bv != nil {
		for _, c := range bv.clients {
			if !slices.Contains(ids, c.user.ID) {
				ids = append(ids, c.user.ID)
			}
		}
	}
	return ids
}

// list returns the people viewing the board, each once, earliest first.
func (r *registry) list(boardID uuid.UUID) []Viewer {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Viewer{}
	if bv := r.boards[boardID]; bv != nil {
		for _, c := range bv.clients {
			i := slices.IndexFunc(out, func(v Viewer) bool { return v.User.ID == c.user.ID })
			if i < 0 {
				out = append(out, Viewer{User: c.user, Since: c.since})
			} else if c.since.Before(out[i].Since) {
				out[i].Since = c.since
			}
		}
	}
	slices.SortFunc(out, func(a, b Viewer) int {
		if c := a.Since.Compare(b.Since); c != 0 {
			return c
		}
		return strings.Compare(a.User.ID.String(), b.User.ID.String())
	})
	return out
}

// expire drops windows not heard from within the TTL and returns the boards whose list
// of viewers changed.
func (r *registry) expire(at time.Time) map[uuid.UUID]scope {
	r.mu.Lock()
	defer r.mu.Unlock()
	changed := map[uuid.UUID]scope{}
	for id, bv := range r.boards {
		for key, c := range bv.clients {
			if at.Sub(c.seen) > r.ttl {
				delete(bv.clients, key)
				if !bv.hasUser(c.user.ID) {
					changed[id] = bv.scope
				}
			}
		}
		if len(bv.clients) == 0 {
			delete(r.boards, id)
		}
	}
	return changed
}

func (r *registry) drop(boardID uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.boards, boardID)
}

// Sweep expires viewers whose windows stopped sending heartbeats, every interval, and
// tells the remaining viewers.
func (s *Service) Sweep(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for boardID, sc := range s.viewers.expire(now()) {
			s.publishViewers(ctx, sc, boardID)
		}
	}
}

// currentViewers lists the people viewing the board who may still see it.
func (s *Service) currentViewers(ctx context.Context, sc scope, boardID uuid.UUID) ([]Viewer, []uuid.UUID, error) {
	list := s.viewers.list(boardID)
	ids := make([]uuid.UUID, len(list))
	for i, v := range list {
		ids[i] = v.User.ID
	}
	allowed, err := s.allowed(ctx, sc, ids)
	if err != nil {
		return nil, nil, err
	}
	list = slices.DeleteFunc(list, func(v Viewer) bool { return !slices.Contains(allowed, v.User.ID) })
	return list, allowed, nil
}

func (s *Service) publishViewers(ctx context.Context, sc scope, boardID uuid.UUID) {
	list, ids, err := s.currentViewers(ctx, sc, boardID)
	if err != nil || len(ids) == 0 {
		return
	}
	s.events.Publish(ids, realtime.Event{Type: "board.viewers", Data: map[string]any{
		"orgId": sc.orgID, "boardId": boardID, "viewers": list,
	}})
}

// Heartbeat registers the caller's window as viewing the board and returns who else is.
func (s *Service) Heartbeat(w http.ResponseWriter, r *http.Request) error {
	_, b, err := s.loadBoard(r)
	if err != nil {
		return err
	}
	var in struct {
		ClientID string `json:"clientId"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if !clientID.MatchString(in.ClientID) {
		return errClientID
	}
	if s.viewers.heartbeat(b.scope, b.ID, in.ClientID, s.person(r), now()) {
		s.publishViewers(r.Context(), b.scope, b.ID)
	}
	list, _, err := s.currentViewers(r.Context(), b.scope, b.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"viewers": list})
	return nil
}

// Leave removes the caller's window from the board's viewers.
func (s *Service) Leave(w http.ResponseWriter, r *http.Request) error {
	m, b, err := s.loadBoard(r)
	if err != nil {
		return err
	}
	if s.viewers.leave(b.ID, r.URL.Query().Get("clientId"), m.UserID) {
		s.publishViewers(r.Context(), b.scope, b.ID)
	}
	httpx.NoContent(w)
	return nil
}

// Cursor relays the caller's pointer to the other viewers; nothing is stored. Updates
// beyond the rate limit are dropped silently: the next one replaces them anyway.
func (s *Service) Cursor(w http.ResponseWriter, r *http.Request) error {
	m, b, err := s.loadBoard(r)
	if err != nil {
		return err
	}
	var in struct {
		ClientID string   `json:"clientId"`
		X        float64  `json:"x"`
		Y        float64  `json:"y"`
		Tool     string   `json:"tool"`
		Button   string   `json:"button"`
		Selected []string `json:"selectedElementIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	fields := map[string]string{}
	if !clientID.MatchString(in.ClientID) {
		fields["clientId"] = "The client ID is not valid."
	}
	if math.Abs(in.X) > 1e7 || math.Abs(in.Y) > 1e7 || (in.Tool != "pointer" && in.Tool != "laser") || (in.Button != "up" && in.Button != "down") ||
		len(in.Selected) > 200 || slices.ContainsFunc(in.Selected, func(id string) bool { return !elementID.MatchString(id) }) {
		fields["pointer"] = "The pointer is not valid."
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	user := s.person(r)
	if s.viewers.heartbeat(b.scope, b.ID, in.ClientID, user, now()) {
		s.publishViewers(r.Context(), b.scope, b.ID)
	}
	if s.cursorsByUser.Allow(m.UserID.String()) {
		if in.Selected == nil {
			in.Selected = []string{}
		}
		s.toViewers(r.Context(), b.scope, b.ID, realtime.Event{Type: "board.cursor", Data: map[string]any{
			"orgId": m.Org.ID, "boardId": b.ID, "clientId": in.ClientID, "user": user,
			"pointer": map[string]any{"x": in.X, "y": in.Y, "tool": in.Tool}, "button": in.Button,
			"selectedElementIds": in.Selected,
		}})
	}
	httpx.NoContent(w)
	return nil
}
