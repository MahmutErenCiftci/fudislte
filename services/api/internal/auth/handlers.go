package auth

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
)

func (s *Service) Logout(w http.ResponseWriter, r *http.Request) error {
	if id := IdentityFrom(r.Context()); id != nil {
		err := database.InTx(r.Context(), s.db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(r.Context(), `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id.SessionID); err != nil {
				return err
			}
			ev := audit.FromRequest(r, "auth.logout")
			ev.ActorID = &id.User.ID
			return audit.Record(r.Context(), tx, ev)
		})
		if err != nil {
			return err
		}
		s.sessionsRevoked(id.SessionID)
	}
	s.clearSessionCookie(w)
	httpx.NoContent(w)
	return nil
}

// UpdateProfile changes the caller's display name and/or preferred language.
func (s *Service) UpdateProfile(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		DisplayName *string `json:"displayName"`
		Locale      *string `json:"locale"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	id := MustIdentity(r.Context())
	user := id.User
	fields := map[string]string{}
	if in.DisplayName != nil {
		name, msg := NormalizeDisplayName(*in.DisplayName)
		if msg != "" {
			fields["displayName"] = msg
		}
		user.DisplayName = name
	}
	if in.Locale != nil {
		l, ok := i18n.Parse(*in.Locale)
		if !ok {
			fields["locale"] = "Choose a supported language."
		}
		user.Locale = string(l)
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE users SET display_name = $2, locale = $3, updated_at = now() WHERE id = $1`,
		user.ID, user.DisplayName, user.Locale); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": user})
	return nil
}

type SessionInfo struct {
	ID         uuid.UUID `json:"id"`
	UserAgent  string    `json:"userAgent"`
	IPAddress  string    `json:"ipAddress"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Current    bool      `json:"current"`
}

func (s *Service) ListSessions(w http.ResponseWriter, r *http.Request) error {
	id := MustIdentity(r.Context())
	rows, err := s.db.Query(r.Context(), `
		SELECT id, user_agent, coalesce(host(ip_address), ''), created_at, last_seen_at, expires_at
		FROM sessions
		WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND last_seen_at > $2
		ORDER BY last_seen_at DESC`,
		id.User.ID, time.Now().Add(-s.opts.SessionIdleTTL))
	if err != nil {
		return err
	}
	defer rows.Close()
	sessions := []SessionInfo{}
	for rows.Next() {
		var si SessionInfo
		if err := rows.Scan(&si.ID, &si.UserAgent, &si.IPAddress, &si.CreatedAt, &si.LastSeenAt, &si.ExpiresAt); err != nil {
			return err
		}
		si.Current = si.ID == id.SessionID
		sessions = append(sessions, si)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
	return nil
}

func (s *Service) RevokeSession(w http.ResponseWriter, r *http.Request) error {
	id := MustIdentity(r.Context())
	sessionID, err := uuid.Parse(chi.URLParam(r, "sessionID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	err = database.InTx(r.Context(), s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, sessionID, id.User.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.ErrNotFound
		}
		ev := audit.FromRequest(r, "auth.session_revoked")
		ev.ActorID = &id.User.ID
		ev.TargetType, ev.TargetID = "session", sessionID.String()
		return audit.Record(r.Context(), tx, ev)
	})
	if err != nil {
		return err
	}
	s.sessionsRevoked(sessionID)
	if sessionID == id.SessionID {
		s.clearSessionCookie(w)
	}
	httpx.NoContent(w)
	return nil
}

func (s *Service) RevokeOtherSessions(w http.ResponseWriter, r *http.Request) error {
	id := MustIdentity(r.Context())
	var revoked []uuid.UUID
	err := database.InTx(r.Context(), s.db, func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id`, id.User.ID, id.SessionID)
		if err != nil {
			return err
		}
		if revoked, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID]); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "auth.other_sessions_revoked")
		ev.ActorID = &id.User.ID
		ev.Metadata = map[string]any{"revokedSessions": len(revoked)}
		return audit.Record(r.Context(), tx, ev)
	})
	if err != nil {
		return err
	}
	s.sessionsRevoked(revoked...)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"revokedSessions": len(revoked)})
	return nil
}
