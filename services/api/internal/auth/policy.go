package auth

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

// Session lifetime is a server-wide setting: everyone signs in again after it, 48 hours
// unless an instance administrator chooses otherwise. Sessions are instance-level (one
// account can belong to several workspaces), so the setting is too.
const (
	DefaultSessionTTL = 48 * time.Hour
	MinSessionTTL     = time.Hour
	MaxSessionTTL     = 90 * 24 * time.Hour
)

type SessionPolicy struct {
	TTLHours  int       `json:"ttlHours"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func requireInstanceAdmin(r *http.Request) (*Identity, error) {
	id := MustIdentity(r.Context())
	if !id.User.IsInstanceAdmin {
		return nil, httpx.ErrForbidden
	}
	return id, nil
}

func (s *Service) GetSessionPolicy(w http.ResponseWriter, r *http.Request) error {
	if _, err := requireInstanceAdmin(r); err != nil {
		return err
	}
	var p SessionPolicy
	if err := s.db.QueryRow(r.Context(), `SELECT session_ttl_hours, updated_at FROM instance_settings`).Scan(&p.TTLHours, &p.UpdatedAt); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"policy": p})
	return nil
}

// UpdateSessionPolicy changes the session lifetime for everyone, including sessions that
// already exist: a shorter lifetime ends sign-ins older than it at once, a longer one
// extends the active ones.
func (s *Service) UpdateSessionPolicy(w http.ResponseWriter, r *http.Request) error {
	id, err := requireInstanceAdmin(r)
	if err != nil {
		return err
	}
	var in struct {
		TTLHours int `json:"ttlHours"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.TTLHours < int(MinSessionTTL.Hours()) || in.TTLHours > int(MaxSessionTTL.Hours()) {
		return httpx.Invalid(map[string]string{"ttlHours": "Choose between 1 hour and 90 days."})
	}

	ctx := r.Context()
	var (
		p     SessionPolicy
		ended []uuid.UUID
	)
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var previous int
		if err := tx.QueryRow(ctx, `SELECT session_ttl_hours FROM instance_settings FOR UPDATE`).Scan(&previous); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			UPDATE instance_settings SET session_ttl_hours = $1, updated_by = $2, updated_at = now()
			RETURNING session_ttl_hours, updated_at`, in.TTLHours, id.User.ID).Scan(&p.TTLHours, &p.UpdatedAt); err != nil {
			return err
		}
		// Expired sessions stay expired; active ones get the new end time.
		rows, err := tx.Query(ctx, `
			UPDATE sessions SET expires_at = created_at + make_interval(hours => $1)
			WHERE revoked_at IS NULL AND expires_at > now()
			RETURNING id, expires_at <= now()`, in.TTLHours)
		if err != nil {
			return err
		}
		for rows.Next() {
			var (
				sessionID uuid.UUID
				expired   bool
			)
			if err := rows.Scan(&sessionID, &expired); err != nil {
				rows.Close()
				return err
			}
			if expired {
				ended = append(ended, sessionID)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "instance.session_policy_updated")
		ev.ActorID = &id.User.ID
		ev.Metadata = map[string]any{"fromHours": previous, "toHours": p.TTLHours, "endedSessions": len(ended)}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.sessionsRevoked(ended...)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"policy": p, "endedSessions": len(ended)})
	return nil
}
