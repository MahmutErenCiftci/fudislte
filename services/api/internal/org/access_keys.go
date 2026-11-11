package org

import (
	"crypto/rand"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
)

// Access keys let an administrator prepare an account and hand the person a single-use
// key instead of an email invitation: entering the key on the sign-in page creates the
// account with the prepared name, role and language and signs it in at once. Later
// sign-ins use email codes.
//
// A key replaces the proof that the person owns the address, so it only ever creates a
// new account — it never signs in to an existing one — and a workspace administrator may
// only create keys for addresses on the workspace's verified domains. Instance
// administrators, who run the server, may create keys for any address. Without these
// rules one workspace could create, and keep a session on, an account that later
// belongs to someone in another workspace.

const (
	defaultAccessKeyDays = 7
	maxAccessKeyDays     = 90
)

type AccessKey struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	Locale      string    `json:"locale"`
	Role        RoleRef   `json:"role"`
	CreatedBy   string    `json:"createdBy"`
	CreatedAt   time.Time `json:"createdAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

// Keys are 20 Crockford base32 characters (100 random bits), shown in groups of five so
// they are easy to read out and type.
const (
	keyAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	keyLength   = 20
)

func newAccessKey() (string, []byte) {
	b := make([]byte, keyLength)
	_, _ = rand.Read(b) // crypto/rand.Read never fails on supported platforms.
	var sb strings.Builder
	for i, x := range b {
		if i > 0 && i%5 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(keyAlphabet[x&31]) // 256 is a multiple of 32: no bias.
	}
	key := sb.String()
	return key, auth.HashToken(normalizeAccessKey(key))
}

// normalizeAccessKey accepts any case, spaces and dashes, and the usual look-alikes (O
// for 0, I and L for 1). It returns "" for anything that cannot be a key.
func normalizeAccessKey(s string) string {
	var sb strings.Builder
	for _, r := range strings.ToUpper(s) {
		switch r {
		case '-', ' ', '\t':
			continue
		case 'O':
			r = '0'
		case 'I', 'L':
			r = '1'
		}
		if r >= 128 || !strings.ContainsRune(keyAlphabet, r) || sb.Len() == keyLength {
			return ""
		}
		sb.WriteRune(r)
	}
	if sb.Len() != keyLength {
		return ""
	}
	return sb.String()
}

var (
	errAccessKeyInvalid = httpx.NewError(http.StatusUnauthorized, "invalid_access_key",
		"This access key is invalid, already used or expired. Ask your administrator for a new one.")
	errAccessKeyAccountExists = httpx.NewError(http.StatusConflict, "account_exists",
		"An account already exists for this email. Sign in with your email address instead.")
)

func (s *Service) ListAccessKeys(w http.ResponseWriter, r *http.Request) error {
	m := mustMembership(r.Context())
	rows, err := s.db.Query(r.Context(), `
		SELECT k.id, k.email, k.display_name, k.locale, r.id, r.key, r.name, r.position,
		       coalesce(u.display_name, ''), k.created_at, k.expires_at
		FROM access_keys k
		JOIN roles r ON r.id = k.role_id
		LEFT JOIN users u ON u.id = k.created_by
		WHERE k.org_id = $1 AND k.used_at IS NULL AND k.revoked_at IS NULL AND k.expires_at > now()
		ORDER BY k.created_at DESC`, m.Org.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	keys := []AccessKey{}
	for rows.Next() {
		var k AccessKey
		if err := rows.Scan(&k.ID, &k.Email, &k.DisplayName, &k.Locale, &k.Role.ID, &k.Role.Key, &k.Role.Name, &k.Role.Position,
			&k.CreatedBy, &k.CreatedAt, &k.ExpiresAt); err != nil {
			return err
		}
		keys = append(keys, k)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"accessKeys": keys})
	return nil
}

// CreateAccessKey prepares an account and returns its key. The key is shown once; only
// its hash is stored. A new key for the same email supersedes the pending one.
func (s *Service) CreateAccessKey(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	var in struct {
		Email       string    `json:"email"`
		DisplayName string    `json:"displayName"`
		RoleID      uuid.UUID `json:"roleId"`
		Locale      string    `json:"locale"`
		ValidDays   int       `json:"validDays"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	fields := map[string]string{}
	email := auth.NormalizeEmail(in.Email)
	if email == "" {
		fields["email"] = "Enter a valid email address."
	}
	name, msg := auth.NormalizeDisplayName(in.DisplayName)
	if msg != "" {
		fields["displayName"] = msg
	}
	locale := i18n.FromContext(ctx)
	if in.Locale != "" {
		l, ok := i18n.Parse(in.Locale)
		if !ok {
			fields["locale"] = "Choose a supported language."
		}
		locale = l
	}
	days := in.ValidDays
	if days == 0 {
		days = defaultAccessKeyDays
	}
	if days < 1 || days > maxAccessKeyDays {
		fields["validDays"] = "Choose between 1 and 90 days."
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}

	instanceAdmin := auth.MustIdentity(ctx).User.IsInstanceAdmin
	key, hash := newAccessKey()
	k := AccessKey{ID: uuid.Must(uuid.NewV7()), Email: email, DisplayName: name, Locale: string(locale)}
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		role, err := loadRole(ctx, tx, actor.Org.ID, in.RoleID)
		if err != nil {
			return err
		}
		if role == nil {
			return httpx.Invalid(map[string]string{"roleId": "Choose a role from this workspace."})
		}
		if !actor.CanAssign(*role) {
			return httpx.NewError(http.StatusForbidden, "forbidden", "You can only invite people with a role that ranks below yours.")
		}
		// The domain check comes first: otherwise the answer would tell whether an address
		// outside this workspace has an account on the server.
		if !instanceAdmin {
			var verified bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM organization_domains WHERE org_id = $1 AND domain = $2 AND verified_at IS NOT NULL)`,
				actor.Org.ID, domainOf(email)).Scan(&verified); err != nil {
				return err
			}
			if !verified {
				return httpx.Invalid(map[string]string{"email": "Use an address on one of this workspace's verified email domains. A server administrator can create keys for any address."})
			}
		}
		exists, err := auth.UserExists(ctx, tx, email)
		if err != nil {
			return err
		}
		if exists {
			return httpx.Invalid(map[string]string{"email": "This person already has an account. Invite them instead."})
		}
		if _, err := tx.Exec(ctx, `
			UPDATE access_keys SET revoked_at = now()
			WHERE org_id = $1 AND email = $2 AND used_at IS NULL AND revoked_at IS NULL`, actor.Org.ID, email); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO access_keys (id, org_id, email, display_name, locale, role_id, key_hash, created_by, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9))
			RETURNING created_at, expires_at`,
			k.ID, actor.Org.ID, email, name, k.Locale, role.ID, hash, actor.UserID, days).
			Scan(&k.CreatedAt, &k.ExpiresAt); err != nil {
			return err
		}
		k.Role = RoleRef{ID: role.ID, Key: role.Key, Name: role.Name, Position: role.Position}
		if err := tx.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1`, actor.UserID).Scan(&k.CreatedBy); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "access_key.created")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "access_key", k.ID.String()
		ev.Metadata = map[string]any{"email": email, "role": role.Name, "validDays": days}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"accessKey": k, "key": key})
	return nil
}

func (s *Service) RevokeAccessKey(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	keyID, err := uuid.Parse(chi.URLParam(r, "keyID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var email string
		err := tx.QueryRow(ctx, `
			UPDATE access_keys SET revoked_at = now()
			WHERE id = $1 AND org_id = $2 AND used_at IS NULL AND revoked_at IS NULL
			RETURNING email`, keyID, actor.Org.ID).Scan(&email)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.ErrNotFound
		}
		if err != nil {
			return err
		}
		ev := audit.FromRequest(r, "access_key.revoked")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "access_key", keyID.String()
		ev.Metadata = map[string]any{"email": email}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// RedeemAccessKey is public: it creates the prepared account, makes it a member of the
// workspace and signs it in.
func (s *Service) RedeemAccessKey(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if !s.accessKeysByIP.Allow(httpx.RateKey(httpx.ClientIP(ctx))) {
		return httpx.ErrRateLimited
	}
	var in struct {
		Key string `json:"key"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	key := normalizeAccessKey(in.Key)
	if key == "" {
		return errAccessKeyInvalid
	}

	var (
		user  auth.User
		o     Organization
		token string
	)
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var (
			keyID, orgID, roleID uuid.UUID
			email, name, locale  string
			allowed              bool
		)
		// A key made by someone who is not a server administrator is only good while its
		// domain is still verified for the workspace.
		err := tx.QueryRow(ctx, `
			SELECT k.id, k.org_id, k.email, k.display_name, k.locale, k.role_id,
			       COALESCE(u.is_instance_admin, false) OR EXISTS (
			         SELECT 1 FROM organization_domains d
			         WHERE d.org_id = k.org_id AND d.domain = substring(k.email from '@([^@]*)$') AND d.verified_at IS NOT NULL)
			FROM access_keys k LEFT JOIN users u ON u.id = k.created_by
			WHERE k.key_hash = $1 AND k.used_at IS NULL AND k.revoked_at IS NULL AND k.expires_at > now()
			FOR UPDATE OF k`, auth.HashToken(key)).Scan(&keyID, &orgID, &email, &name, &locale, &roleID, &allowed)
		if errors.Is(err, pgx.ErrNoRows) {
			return errAccessKeyInvalid
		}
		if err != nil {
			return err
		}
		if !allowed {
			return errAccessKeyInvalid
		}
		exists, err := auth.UserExists(ctx, tx, email)
		if err != nil {
			return err
		}
		if exists {
			return errAccessKeyAccountExists
		}
		if user, err = s.auth.CreateUser(ctx, tx, auth.NewUser{Email: email, DisplayName: name, Locale: i18n.Locale(locale)}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role_id) VALUES ($1, $2, $3)`, orgID, user.ID, roleID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE access_keys SET used_at = now(), used_by = $2 WHERE id = $1`, keyID, user.ID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "access_key.used")
		ev.OrgID, ev.ActorID = &orgID, &user.ID
		ev.TargetType, ev.TargetID = "access_key", keyID.String()
		ev.Metadata = map[string]any{"email": email}
		if err := audit.Record(ctx, tx, ev); err != nil {
			return err
		}
		login := audit.FromRequest(r, "auth.login")
		login.ActorID = &user.ID
		login.Metadata = map[string]any{"method": "access_key", "newAccount": true}
		if err := audit.Record(ctx, tx, login); err != nil {
			return err
		}
		if token, err = s.auth.CreateSession(ctx, tx, r, user.ID); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT id, name, slug, created_at FROM organizations WHERE id = $1`, orgID).
			Scan(&o.ID, &o.Name, &o.Slug, &o.CreatedAt)
	})
	if err != nil {
		return err
	}
	s.auth.SetSessionCookie(w, token)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": user, "organization": o})
	return nil
}
