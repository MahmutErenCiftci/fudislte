// Package auth implements accounts, one-time email codes and server-side sessions.
// FUDISLTE has no user passwords (ADR-0006). The package has no knowledge of
// organizations; see package org for tenancy.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

type Options struct {
	CookieSecure bool
	// SessionIdleTTL ends sessions that have not been used for this long. How long a
	// session lasts at most is an instance setting (see policy.go).
	SessionIdleTTL time.Duration
	// SessionsRevoked, when set, is called after sessions are revoked so live
	// connections that belong to them can be closed.
	SessionsRevoked func(ids ...uuid.UUID)
}

type Service struct {
	db   *pgxpool.Pool
	opts Options
}

func NewService(db *pgxpool.Pool, opts Options) *Service {
	return &Service{db: db, opts: opts}
}

// Identity is the authenticated caller of a request.
type Identity struct {
	User      User
	SessionID uuid.UUID
}

type identityKey struct{}

func IdentityFrom(ctx context.Context) *Identity {
	id, _ := ctx.Value(identityKey{}).(*Identity)
	return id
}

// MustIdentity returns the caller of a route protected by RequireAuth.
func MustIdentity(ctx context.Context) *Identity {
	id := IdentityFrom(ctx)
	if id == nil {
		panic("auth: MustIdentity used on a route without RequireAuth")
	}
	return id
}

// NewToken returns a 256-bit random token and the SHA-256 hash that is stored.
func NewToken() (string, []byte) {
	b := make([]byte, 32)
	_, _ = rand.Read(b) // crypto/rand.Read never fails on supported platforms.
	token := base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token)
}

func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// RevokeUserSessions revokes every session of userID inside q and returns their IDs.
// Pass them to CloseSessions once the transaction has committed.
func RevokeUserSessions(ctx context.Context, q database.Querier, userID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// CloseSessions ends what revoked sessions still hold open, such as live event streams.
func (s *Service) CloseSessions(ids ...uuid.UUID) { s.sessionsRevoked(ids...) }

func (s *Service) sessionsRevoked(ids ...uuid.UUID) {
	if s.opts.SessionsRevoked != nil && len(ids) > 0 {
		s.opts.SessionsRevoked(ids...)
	}
}

func (s *Service) cookieName() string {
	if s.opts.CookieSecure {
		return "__Host-fudislte_session"
	}
	return "fudislte_session"
}

// CreateSession inserts a session for userID that lasts as long as the instance's
// session lifetime, and returns the raw token. Call SetSessionCookie only after the
// surrounding transaction has committed.
func (s *Service) CreateSession(ctx context.Context, q database.Querier, r *http.Request, userID uuid.UUID) (string, error) {
	token, hash := NewToken()
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = ua[:512]
	}
	tag, err := q.Exec(ctx, `
		INSERT INTO sessions (id, user_id, token_hash, user_agent, ip_address, expires_at)
		SELECT $1, $2, $3, $4, $5::inet, now() + make_interval(hours => session_ttl_hours)
		FROM instance_settings`,
		uuid.Must(uuid.NewV7()), userID, hash, ua, httpx.IPString(httpx.ClientIP(ctx)))
	if err == nil && tag.RowsAffected() != 1 {
		err = errors.New("auth: instance_settings has no row")
	}
	return token, err
}

// SetSessionCookie stores the session token. The cookie outlives any session the
// lifetime setting allows, so a longer lifetime also applies to existing sign-ins; the
// server alone decides when a session ends.
func (s *Service) SetSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName(),
		Value:    token,
		Path:     "/",
		MaxAge:   int(MaxSessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.opts.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName(),
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.opts.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

var errNoSession = errors.New("no valid session")

// touchInterval throttles last_seen_at writes to one per session per interval.
const touchInterval = 5 * time.Minute

func (s *Service) lookup(ctx context.Context, token string) (*Identity, error) {
	var (
		id                     Identity
		lastSeen               time.Time
		statusKind, statusText string
		statusExpires          *time.Time
		statusMute             bool
	)
	err := s.db.QueryRow(ctx, `
		SELECT s.id, s.last_seen_at, u.id, u.email, u.display_name, u.locale, u.is_instance_admin, u.created_at,
		       u.status_kind, u.status_text, u.status_expires_at, u.status_mute
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1
		  AND s.revoked_at IS NULL
		  AND s.expires_at > now()
		  AND s.last_seen_at > $2
		  AND u.disabled_at IS NULL`,
		HashToken(token), time.Now().Add(-s.opts.SessionIdleTTL)).
		Scan(&id.SessionID, &lastSeen, &id.User.ID, &id.User.Email, &id.User.DisplayName, &id.User.Locale, &id.User.IsInstanceAdmin, &id.User.CreatedAt,
			&statusKind, &statusText, &statusExpires, &statusMute)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNoSession
	}
	if err != nil {
		return nil, err
	}
	id.User.Status = MakeStatus(statusKind, statusText, statusExpires, statusMute)
	if time.Since(lastSeen) > touchInterval {
		if _, err := s.db.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, id.SessionID); err != nil {
			slog.WarnContext(ctx, "could not update session activity", "error", err)
		}
	}
	return &id, nil
}

// Authenticate attaches the caller's Identity to the context when the request carries a
// valid session cookie. It never rejects a request; use RequireAuth for that.
func (s *Service) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(s.cookieName())
		if err != nil || c.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		id, err := s.lookup(r.Context(), c.Value)
		switch {
		case errors.Is(err, errNoSession):
			s.clearSessionCookie(w)
			next.ServeHTTP(w, r)
		case err != nil:
			httpx.WriteError(w, r, err)
		default:
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, id)))
		}
	})
}

func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if IdentityFrom(r.Context()) == nil {
			httpx.WriteError(w, r, httpx.ErrUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
