package auth

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
)

type User struct {
	ID              uuid.UUID `json:"id"`
	Email           string    `json:"email"`
	DisplayName     string    `json:"displayName"`
	Locale          string    `json:"locale"`
	IsInstanceAdmin bool      `json:"isInstanceAdmin"`
	CreatedAt       time.Time `json:"createdAt"`
	// Status is the person's own status, mute included; nil when none is set.
	Status *Status `json:"status,omitempty"`
}

// Status says what someone is doing (docs/architecture/phase-2.md, increment 2.4).
type Status struct {
	Kind      string     `json:"kind"` // meeting, coding, focus, call or custom
	Text      string     `json:"text"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	// Mute silences the person's desktop notifications; only they see it.
	Mute bool `json:"mute"`
}

// MakeStatus returns the stored status, or nil when none is set or it has expired.
func MakeStatus(kind, text string, expiresAt *time.Time, mute bool) *Status {
	if kind == "" || (expiresAt != nil && !expiresAt.After(time.Now())) {
		return nil
	}
	return &Status{Kind: kind, Text: text, ExpiresAt: expiresAt, Mute: mute}
}

// NormalizeEmail trims and lower-cases a plain address ("name@example.com"). It returns
// "" when the input is not a single plain address.
func NormalizeEmail(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) < 3 || len(s) > 254 {
		return ""
	}
	addr, err := mail.ParseAddress(s)
	if err != nil || addr.Name != "" || addr.Address != s {
		return ""
	}
	return s
}

// NormalizeDisplayName collapses whitespace and returns a user-facing message when the
// name is unacceptable.
func NormalizeDisplayName(s string) (string, string) {
	s = strings.Join(strings.Fields(s), " ")
	if strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", "Name contains invalid characters."
	}
	switch n := utf8.RuneCountInString(s); {
	case n == 0:
		return "", "Enter a name."
	case n > 80:
		return "", "Use at most 80 characters."
	}
	return s, ""
}

// NameFromEmail suggests a display name from an address: "dana.yilmaz@x" → "Dana Yilmaz".
// People can change it in their profile.
func NameFromEmail(email string) string {
	local := email
	if i := strings.IndexByte(email, '@'); i > 0 {
		local = email[:i]
	}
	parts := strings.FieldsFunc(local, func(r rune) bool { return r == '.' || r == '_' || r == '-' || r == '+' || unicode.IsDigit(r) })
	for i, p := range parts {
		r, size := utf8.DecodeRuneInString(p)
		parts[i] = string(unicode.ToUpper(r)) + p[size:]
	}
	name, msg := NormalizeDisplayName(strings.Join(parts, " "))
	if msg != "" {
		name, _ = NormalizeDisplayName(local)
	}
	if utf8.RuneCountInString(name) > 80 {
		name = string([]rune(name)[:80])
	}
	return name
}

type NewUser struct {
	Email           string
	DisplayName     string
	Locale          i18n.Locale
	IsInstanceAdmin bool
}

// CreateUser validates and inserts a user. Validation problems are returned as
// *httpx.Error with per-field messages.
func (s *Service) CreateUser(ctx context.Context, q database.Querier, in NewUser) (User, error) {
	fields := map[string]string{}
	email := NormalizeEmail(in.Email)
	if email == "" {
		fields["email"] = "Enter a valid email address."
	}
	name, msg := NormalizeDisplayName(in.DisplayName)
	if msg != "" {
		fields["displayName"] = msg
	}
	if len(fields) > 0 {
		return User{}, httpx.Invalid(fields)
	}

	locale := in.Locale
	if _, ok := i18n.Parse(string(locale)); !ok {
		locale = i18n.Turkish
	}
	u := User{ID: uuid.Must(uuid.NewV7()), Email: email, DisplayName: name, Locale: string(locale), IsInstanceAdmin: in.IsInstanceAdmin}
	err := q.QueryRow(ctx, `
		INSERT INTO users (id, email, display_name, locale, is_instance_admin)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING created_at`,
		u.ID, u.Email, u.DisplayName, u.Locale, u.IsInstanceAdmin).Scan(&u.CreatedAt)
	if database.IsUniqueViolation(err, "users_email_key") {
		return User{}, httpx.Invalid(map[string]string{"email": "An account with this email already exists."})
	}
	return u, err
}

// UserExists reports whether an active or disabled account uses the email.
func UserExists(ctx context.Context, q database.Querier, email string) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE email = $1)`, email).Scan(&exists)
	return exists, err
}

// FindUser returns the account for email, or nil when none exists.
func FindUser(ctx context.Context, q database.Querier, email string) (u *User, disabled bool, err error) {
	var user User
	var disabledAt *time.Time
	err = q.QueryRow(ctx, `
		SELECT id, email, display_name, locale, is_instance_admin, created_at, disabled_at
		FROM users WHERE email = $1`, email).
		Scan(&user.ID, &user.Email, &user.DisplayName, &user.Locale, &user.IsInstanceAdmin, &user.CreatedAt, &disabledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return &user, disabledAt != nil, nil
}
