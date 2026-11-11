// Package org implements organizations (workspaces), roles, memberships and
// invitations, and enforces tenant isolation for every organization-scoped route.
package org

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
	"fudislte/api/internal/mail"
)

type Service struct {
	db              *pgxpool.Pool
	auth            *auth.Service
	outbox          *mail.Outbox
	publicURL       string
	invitationsByIP *httpx.Limiter
	accessKeysByIP  *httpx.Limiter
	// invitationCodesByEmail caps code emails per invited address, like sign-in codes,
	// so a forwarded link cannot be used to flood a mailbox or guess codes without end.
	invitationCodesByEmail *httpx.Limiter
	// invitationsByActor caps how many invitation emails one person can send.
	invitationsByActor *httpx.Limiter
	// verifyAttempts limits DNS lookups for domain verification per workspace.
	verifyAttempts *httpx.Limiter
	lookupTXT      LookupTXT
}

// NewService creates the workspace service; lookup resolves TXT records for domain
// verification (nil: the system resolver).
func NewService(db *pgxpool.Pool, authSvc *auth.Service, outbox *mail.Outbox, publicURL string, lookup LookupTXT) *Service {
	if lookup == nil {
		lookup = net.DefaultResolver.LookupTXT
	}
	return &Service{
		db:                     db,
		auth:                   authSvc,
		outbox:                 outbox,
		publicURL:              publicURL,
		invitationsByIP:        httpx.NewLimiter(3*time.Second, 20),
		accessKeysByIP:         httpx.NewLimiter(3*time.Second, 20),
		invitationCodesByEmail: httpx.NewLimiter(10*time.Minute, 3),
		invitationsByActor:     httpx.NewLimiter(30*time.Second, 50),
		verifyAttempts:         httpx.NewLimiter(10*time.Second, 10),
		lookupTXT:              lookup,
	}
}

type Organization struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	CreatedAt time.Time `json:"createdAt"`
}

type Role struct {
	ID          uuid.UUID    `json:"id"`
	Key         string       `json:"key"`
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Position    int          `json:"position"`
	Permissions []Permission `json:"permissions"`
	IsSystem    bool         `json:"isSystem"`
}

func (r Role) isOwner() bool { return r.IsSystem && r.Key == OwnerRoleKey }

// Membership is the caller's relationship to one organization.
type Membership struct {
	Org      Organization
	Role     Role
	UserID   uuid.UUID
	JoinedAt time.Time
}

func (m *Membership) Can(p Permission) bool { return slices.Contains(m.Role.Permissions, p) }

func (m *Membership) IsOwner() bool { return m.Role.isOwner() }

// Outranks reports whether the member has authority over a role ranked at position.
// Owners have authority over everything, including other owners.
func (m *Membership) Outranks(position int) bool {
	return m.IsOwner() || m.Role.Position > position
}

// CanAssign reports whether the member may give role r to someone. Only owners may
// assign the Owner role; everyone else may only assign roles ranked below their own
// that grant nothing they do not hold themselves. Without the second rule, someone who
// may invite could give a second account of their own a lower-ranked custom role that
// carries permissions they lack.
func (m *Membership) CanAssign(r Role) bool {
	if r.isOwner() {
		return m.IsOwner()
	}
	if m.IsOwner() {
		return true
	}
	if r.Position >= m.Role.Position {
		return false
	}
	for _, p := range r.Permissions {
		if !m.Can(p) {
			return false
		}
	}
	return true
}

// NormalizeName validates an organization name, returning a user-facing message on failure.
func NormalizeName(s string) (string, string) {
	s = strings.Join(strings.Fields(s), " ")
	if strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", "Name contains invalid characters."
	}
	switch n := utf8.RuneCountInString(s); {
	case n < 2:
		return "", "Use at least 2 characters."
	case n > 80:
		return "", "Use at most 80 characters."
	}
	return s, ""
}

// CreateOrganization creates an organization with the default roles and makes ownerID
// its Owner. Run it inside a transaction.
func CreateOrganization(ctx context.Context, q database.Querier, name string, ownerID uuid.UUID) (Organization, error) {
	name, msg := NormalizeName(name)
	if msg != "" {
		return Organization{}, httpx.Invalid(map[string]string{"name": msg})
	}
	slug, err := availableSlug(ctx, q, slugify(name))
	if err != nil {
		return Organization{}, err
	}
	o := Organization{ID: uuid.Must(uuid.NewV7()), Name: name, Slug: slug}
	if err := q.QueryRow(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) RETURNING created_at`,
		o.ID, o.Name, o.Slug).Scan(&o.CreatedAt); err != nil {
		return Organization{}, err
	}

	var ownerRoleID uuid.UUID
	for _, t := range defaultRoles {
		id := uuid.Must(uuid.NewV7())
		if t.Key == OwnerRoleKey {
			ownerRoleID = id
		}
		if _, err := q.Exec(ctx, `
			INSERT INTO roles (id, org_id, key, name, description, position, permissions, is_system)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			id, o.ID, t.Key, t.Name, t.Description, t.Position, permissionStrings(t.Permissions), t.System); err != nil {
			return Organization{}, err
		}
	}
	// The default channel is named in the creator's language. Members join it through
	// the memberships trigger (migration 00004), the owner included.
	if _, err := q.Exec(ctx, `INSERT INTO channels (id, org_id, name, visibility, is_default, created_by) VALUES ($1, $2, $3, 'public', true, $4)`,
		uuid.Must(uuid.NewV7()), o.ID, i18n.T(i18n.FromContext(ctx), "general"), ownerID); err != nil {
		return Organization{}, err
	}
	if _, err := q.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role_id) VALUES ($1, $2, $3)`,
		o.ID, ownerID, ownerRoleID); err != nil {
		return Organization{}, err
	}
	return o, nil
}

var slugReplacer = strings.NewReplacer(
	"ç", "c", "ğ", "g", "ı", "i", "ö", "o", "ş", "s", "ü", "u",
	"ä", "a", "ß", "ss", "á", "a", "à", "a", "â", "a", "é", "e", "è", "e", "ê", "e",
	"í", "i", "î", "i", "ñ", "n", "ó", "o", "ô", "o", "ú", "u", "û", "u",
)

func slugify(name string) string {
	s := slugReplacer.Replace(strings.ToLower(name))
	var b strings.Builder
	dash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.TrimRight(b.String(), "-")
	if len(out) > 40 {
		out = strings.TrimRight(out[:40], "-")
	}
	if out == "" {
		out = "workspace"
	}
	return out
}

func availableSlug(ctx context.Context, q database.Querier, base string) (string, error) {
	for i := 1; i <= 50; i++ {
		candidate := base
		if i > 1 {
			candidate = fmt.Sprintf("%s-%d", base, i)
		}
		var taken bool
		if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM organizations WHERE slug = $1)`, candidate).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return base + "-" + randomHex(3), nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func permissionStrings(ps []Permission) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = string(p)
	}
	return out
}

func toPermissions(ss []string) []Permission {
	out := make([]Permission, len(ss))
	for i, s := range ss {
		out[i] = Permission(s)
	}
	return out
}

const roleColumns = `r.id, r.key, r.name, r.description, r.position, r.permissions, r.is_system`

func scanRole(row pgx.Row, extra ...any) (Role, error) {
	var r Role
	var perms []string
	dest := append([]any{&r.ID, &r.Key, &r.Name, &r.Description, &r.Position, &perms, &r.IsSystem}, extra...)
	if err := row.Scan(dest...); err != nil {
		return Role{}, err
	}
	r.Permissions = toPermissions(perms)
	return r, nil
}

// loadRole returns a role of orgID, or nil when it does not exist in that organization.
func loadRole(ctx context.Context, q database.Querier, orgID, roleID uuid.UUID) (*Role, error) {
	r, err := scanRole(q.QueryRow(ctx, `SELECT `+roleColumns+` FROM roles r WHERE r.org_id = $1 AND r.id = $2`, orgID, roleID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

const membershipQuery = `
	SELECT o.id, o.name, o.slug, o.created_at, ` + roleColumns + `, m.user_id, m.joined_at
	FROM memberships m
	JOIN organizations o ON o.id = m.org_id
	JOIN roles r ON r.id = m.role_id`

func scanMembership(row pgx.Row) (*Membership, error) {
	var m Membership
	var perms []string
	if err := row.Scan(&m.Org.ID, &m.Org.Name, &m.Org.Slug, &m.Org.CreatedAt,
		&m.Role.ID, &m.Role.Key, &m.Role.Name, &m.Role.Description, &m.Role.Position, &perms, &m.Role.IsSystem,
		&m.UserID, &m.JoinedAt); err != nil {
		return nil, err
	}
	m.Role.Permissions = toPermissions(perms)
	return &m, nil
}

// LoadMembership returns userID's membership in orgID, or nil when there is none.
func LoadMembership(ctx context.Context, q database.Querier, orgID, userID uuid.UUID) (*Membership, error) {
	m, err := scanMembership(q.QueryRow(ctx, membershipQuery+` WHERE m.org_id = $1 AND m.user_id = $2`, orgID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return m, err
}

func ListMemberships(ctx context.Context, q database.Querier, userID uuid.UUID) ([]Membership, error) {
	rows, err := q.Query(ctx, membershipQuery+` WHERE m.user_id = $1 ORDER BY m.joined_at, o.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Membership{}
	for rows.Next() {
		m, err := scanMembership(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

// lockOwners locks the organization's owner memberships for the rest of the
// transaction and returns how many there are, so "last owner" checks cannot race.
func lockOwners(ctx context.Context, tx pgx.Tx, orgID uuid.UUID) (int, error) {
	rows, err := tx.Query(ctx, `
		SELECT m.user_id FROM memberships m
		JOIN roles r ON r.id = m.role_id
		WHERE m.org_id = $1 AND r.key = $2 AND r.is_system
		FOR UPDATE OF m`, orgID, OwnerRoleKey)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		n++
	}
	return n, rows.Err()
}
