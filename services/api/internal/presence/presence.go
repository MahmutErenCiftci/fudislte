// Package presence shows who is online and what they are doing: presence comes from the
// live event streams (realtime.Hub), status from the person (docs/architecture/phase-2.md,
// increment 2.4).
package presence

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/auth"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

type Service struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewService(db *pgxpool.Pool, hub *realtime.Hub) *Service {
	s := &Service{db: db, hub: hub}
	hub.OnPresence(func(changes map[uuid.UUID]realtime.State) {
		s.publish(context.Background(), changes)
	})
	return s
}

// Status is what other people see of someone's status; mute stays private.
type Status struct {
	Kind      string     `json:"kind"`
	Text      string     `json:"text"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

type Entry struct {
	UserID uuid.UUID      `json:"userId"`
	State  realtime.State `json:"state"`
	Status *Status        `json:"status"`
}

func public(s *auth.Status) *Status {
	if s == nil {
		return nil
	}
	return &Status{Kind: s.Kind, Text: s.Text, ExpiresAt: s.ExpiresAt}
}

var kinds = []string{"meeting", "coding", "focus", "call", "custom"}

const maxStatusAhead = 30 * 24 * time.Hour

// ListPresence returns the presence and status of every member of the workspace.
func (s *Service) ListPresence(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	rows, err := s.db.Query(r.Context(), `
		SELECT u.id, u.status_kind, u.status_text, u.status_expires_at
		FROM memberships m JOIN users u ON u.id = m.user_id
		WHERE m.org_id = $1`, m.Org.ID)
	if err != nil {
		return err
	}
	entries, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Entry, error) {
		var (
			e          Entry
			kind, text string
			expires    *time.Time
		)
		err := row.Scan(&e.UserID, &kind, &text, &expires)
		e.Status = public(auth.MakeStatus(kind, text, expires, false))
		return e, err
	})
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(entries))
	for i, e := range entries {
		ids[i] = e.UserID
	}
	states := s.hub.Presence(ids)
	for i := range entries {
		entries[i].State = states[entries[i].UserID]
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"presence": entries})
	return nil
}

// SetStatus sets the caller's status: {kind, text, expiresAt, mute}.
func (s *Service) SetStatus(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := auth.MustIdentity(ctx)
	var in struct {
		Kind      string     `json:"kind"`
		Text      string     `json:"text"`
		ExpiresAt *time.Time `json:"expiresAt"`
		Mute      bool       `json:"mute"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	text := strings.Join(strings.FieldsFunc(in.Text, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	fields := map[string]string{}
	if !slices.Contains(kinds, in.Kind) {
		fields["kind"] = "Choose a status."
	}
	switch {
	case utf8.RuneCountInString(text) > 100:
		fields["text"] = "Use at most 100 characters."
	case in.Kind == "custom" && text == "":
		fields["text"] = "Write your status."
	}
	if in.ExpiresAt != nil && (!in.ExpiresAt.After(time.Now()) || in.ExpiresAt.After(time.Now().Add(maxStatusAhead))) {
		fields["expiresAt"] = "Choose a time within the next 30 days."
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	if _, err := s.db.Exec(ctx, `
		UPDATE users SET status_kind = $2, status_text = $3, status_expires_at = $4, status_mute = $5, updated_at = now()
		WHERE id = $1`, id.User.ID, in.Kind, text, in.ExpiresAt, in.Mute); err != nil {
		return err
	}
	status := auth.MakeStatus(in.Kind, text, in.ExpiresAt, in.Mute)
	s.publishOne(ctx, id.User.ID)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"status": status})
	return nil
}

// ClearStatus removes the caller's status.
func (s *Service) ClearStatus(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := auth.MustIdentity(ctx)
	if _, err := s.db.Exec(ctx, `
		UPDATE users SET status_kind = '', status_text = '', status_expires_at = NULL, status_mute = false, updated_at = now()
		WHERE id = $1`, id.User.ID); err != nil {
		return err
	}
	s.publishOne(ctx, id.User.ID)
	httpx.NoContent(w)
	return nil
}

// publish tells everyone who may see each changed user in a member directory — and the
// user's own other windows — about their presence and status. Two queries serve the
// whole batch, however many people changed.
func (s *Service) publish(ctx context.Context, changes map[uuid.UUID]realtime.State) {
	ids := make([]uuid.UUID, 0, len(changes))
	for id := range changes {
		ids = append(ids, id)
	}
	rows, err := s.db.Query(ctx, `SELECT id, status_kind, status_text, status_expires_at FROM users WHERE id = ANY ($1)`, ids)
	if err != nil {
		slog.Warn("presence: load status", "error", err)
		return
	}
	statuses := map[uuid.UUID]*Status{}
	for rows.Next() {
		var (
			id         uuid.UUID
			kind, text string
			expires    *time.Time
		)
		if err := rows.Scan(&id, &kind, &text, &expires); err != nil {
			rows.Close()
			slog.Warn("presence: load status", "error", err)
			return
		}
		statuses[id] = public(auth.MakeStatus(kind, text, expires, false))
	}
	if err := rows.Err(); err != nil {
		slog.Warn("presence: load status", "error", err)
		return
	}
	rows, err = s.db.Query(ctx, `
		SELECT DISTINCT mine.user_id, viewer.user_id
		FROM memberships mine
		JOIN memberships viewer ON viewer.org_id = mine.org_id
		JOIN roles r ON r.id = viewer.role_id
		WHERE mine.user_id = ANY ($1) AND $2 = ANY (r.permissions)`, ids, string(org.PermMembersView))
	if err != nil {
		slog.Warn("presence: load viewers", "error", err)
		return
	}
	viewers := map[uuid.UUID][]uuid.UUID{}
	for rows.Next() {
		var user, viewer uuid.UUID
		if err := rows.Scan(&user, &viewer); err != nil {
			rows.Close()
			slog.Warn("presence: load viewers", "error", err)
			return
		}
		viewers[user] = append(viewers[user], viewer)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("presence: load viewers", "error", err)
		return
	}
	for id, state := range changes {
		to := viewers[id]
		if !slices.Contains(to, id) {
			to = append(to, id)
		}
		s.hub.Publish(to, realtime.Event{Type: "presence.changed", Data: Entry{UserID: id, State: state, Status: statuses[id]}})
	}
}

// publishOne publishes userID's current presence and status after they changed it.
func (s *Service) publishOne(ctx context.Context, userID uuid.UUID) {
	s.publish(ctx, map[uuid.UUID]realtime.State{userID: s.hub.Presence([]uuid.UUID{userID})[userID]})
}
