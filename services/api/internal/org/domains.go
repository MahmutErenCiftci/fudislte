package org

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

// Email domains let anyone with a company address join a workspace on first sign-in,
// with a role chosen by an administrator — once the workspace has proved it controls the
// domain with a DNS TXT record.

type Domain struct {
	Domain    string    `json:"domain"`
	Role      RoleRef   `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
	// Record is the TXT record to publish on the domain (or on _fudislte-verification.<domain>).
	Record     string     `json:"record"`
	VerifiedAt *time.Time `json:"verifiedAt"`
}

const txtPrefix = "fudislte-verification="

var errNotVerified = httpx.NewError(http.StatusUnprocessableEntity, "domain_not_verified",
	"The TXT record was not found. DNS changes can take a while to appear; try again later.")

// LookupTXT resolves TXT records; tests replace it.
type LookupTXT func(ctx context.Context, name string) ([]string, error)

func newVerificationToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var domainPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

// publicEmailDomains are consumer providers: allowing one would let anyone on the
// internet join. Work email only.
var publicEmailDomains = map[string]bool{
	"gmail.com": true, "googlemail.com": true, "outlook.com": true, "hotmail.com": true, "hotmail.com.tr": true,
	"live.com": true, "msn.com": true, "yahoo.com": true, "ymail.com": true, "icloud.com": true, "me.com": true,
	"mac.com": true, "aol.com": true, "proton.me": true, "protonmail.com": true, "pm.me": true, "gmx.com": true,
	"gmx.de": true, "gmx.net": true, "web.de": true, "mail.com": true, "yandex.com": true, "yandex.ru": true,
	"yandex.com.tr": true, "zoho.com": true, "mail.ru": true, "tutanota.com": true, "fastmail.com": true,
	"mynet.com": true, "qq.com": true, "163.com": true,
}

// managementPermissions may not be handed out automatically by domain.
var managementPermissions = []Permission{PermOrgManage, PermMembersManage, PermRolesManage, PermChannelsManage, PermMessagesManage, PermRoomsManage, PermProjectsManage}

func hasManagementPermission(perms []Permission) bool {
	return slices.ContainsFunc(perms, func(p Permission) bool { return slices.Contains(managementPermissions, p) })
}

// NormalizeDomain validates a domain such as "@Firma.com", returning "firma.com" or a
// user-facing message.
func NormalizeDomain(s string) (string, string) {
	d := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "@")
	switch {
	case len(d) > 253 || !domainPattern.MatchString(d):
		return "", "Enter a domain such as company.com."
	case publicEmailDomains[d]:
		return "", "Public email providers cannot be used. Enter your company's domain."
	}
	return d, ""
}

func domainOf(email string) string {
	return email[strings.LastIndexByte(email, '@')+1:]
}

// DomainMatch is a workspace that accepts an email address by its domain.
type DomainMatch struct {
	OrgID  uuid.UUID
	RoleID uuid.UUID
	Domain string
}

// DomainMatches lists the workspaces whose verified email domains include email's domain.
func DomainMatches(ctx context.Context, q database.Querier, email string) ([]DomainMatch, error) {
	d := domainOf(email)
	rows, err := q.Query(ctx, `SELECT org_id, role_id FROM organization_domains WHERE domain = $1 AND verified_at IS NOT NULL`, d)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DomainMatch
	for rows.Next() {
		m := DomainMatch{Domain: d}
		if err := rows.Scan(&m.OrgID, &m.RoleID); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// JoinByDomain makes a newly created account a member of every matching workspace.
func JoinByDomain(ctx context.Context, tx pgx.Tx, r *http.Request, userID uuid.UUID, matches []DomainMatch) error {
	for _, m := range matches {
		if _, err := tx.Exec(ctx, `
			INSERT INTO memberships (org_id, user_id, role_id) VALUES ($1, $2, $3)
			ON CONFLICT (org_id, user_id) DO NOTHING`, m.OrgID, userID, m.RoleID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "member.joined_by_domain")
		ev.OrgID, ev.ActorID = &m.OrgID, &userID
		ev.TargetType, ev.TargetID = "user", userID.String()
		ev.Metadata = map[string]any{"domain": m.Domain}
		if err := audit.Record(ctx, tx, ev); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) ListDomains(w http.ResponseWriter, r *http.Request) error {
	m := mustMembership(r.Context())
	rows, err := s.db.Query(r.Context(), `
		SELECT d.domain, r.id, r.key, r.name, r.position, d.created_at, d.verification_token, d.verified_at
		FROM organization_domains d JOIN roles r ON r.id = d.role_id
		WHERE d.org_id = $1 ORDER BY d.domain`, m.Org.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	domains := []Domain{}
	for rows.Next() {
		var d Domain
		var token string
		if err := rows.Scan(&d.Domain, &d.Role.ID, &d.Role.Key, &d.Role.Name, &d.Role.Position, &d.CreatedAt, &token, &d.VerifiedAt); err != nil {
			return err
		}
		d.Record = txtPrefix + token
		domains = append(domains, d)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"domains": domains})
	return nil
}

func (s *Service) AddDomain(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	var in struct {
		Domain string    `json:"domain"`
		RoleID uuid.UUID `json:"roleId"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	domain, msg := NormalizeDomain(in.Domain)
	if msg != "" {
		return httpx.Invalid(map[string]string{"domain": msg})
	}
	var out Domain
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		role, err := loadRole(ctx, tx, actor.Org.ID, in.RoleID)
		if err != nil {
			return err
		}
		switch {
		case role == nil:
			return httpx.Invalid(map[string]string{"roleId": "Choose a role from this workspace."})
		case hasManagementPermission(role.Permissions):
			return httpx.Invalid(map[string]string{"roleId": "Choose a role without management permissions for automatic joining."})
		case !actor.CanAssign(*role):
			return errAssign
		}
		token := newVerificationToken()
		err = tx.QueryRow(ctx, `
			INSERT INTO organization_domains (org_id, domain, role_id, created_by, verification_token) VALUES ($1, $2, $3, $4, $5)
			RETURNING created_at`, actor.Org.ID, domain, role.ID, actor.UserID, token).Scan(&out.CreatedAt)
		out.Record = txtPrefix + token
		if database.IsUniqueViolation(err, "") {
			return httpx.Invalid(map[string]string{"domain": "This domain is already added."})
		}
		if err != nil {
			return err
		}
		out.Domain = domain
		out.Role = RoleRef{ID: role.ID, Key: role.Key, Name: role.Name, Position: role.Position}
		ev := audit.FromRequest(r, "org.domain_added")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "domain", domain
		ev.Metadata = map[string]any{"domain": domain, "role": role.Name}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"domain": out})
	return nil
}

func (s *Service) RemoveDomain(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	domain := strings.ToLower(chi.URLParam(r, "domain"))
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var removed string
		err := tx.QueryRow(ctx, `DELETE FROM organization_domains WHERE org_id = $1 AND domain = $2 RETURNING domain`,
			actor.Org.ID, domain).Scan(&removed)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.ErrNotFound
		}
		if err != nil {
			return err
		}
		ev := audit.FromRequest(r, "org.domain_removed")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "domain", removed
		ev.Metadata = map[string]any{"domain": removed}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// VerifyDomain looks for the domain's TXT record — on the domain itself or on
// _fudislte-verification.<domain> — and marks the domain verified when it is there.
func (s *Service) VerifyDomain(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	domain := strings.ToLower(chi.URLParam(r, "domain"))
	var token string
	var verifiedAt *time.Time
	err := s.db.QueryRow(ctx, `SELECT verification_token, verified_at FROM organization_domains WHERE org_id = $1 AND domain = $2`,
		actor.Org.ID, domain).Scan(&token, &verifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.ErrNotFound
	}
	if err != nil {
		return err
	}
	if verifiedAt == nil {
		if !s.verifyAttempts.Allow(actor.Org.ID.String()) {
			return httpx.ErrRateLimited
		}
		if !s.hasRecord(ctx, domain, txtPrefix+token) {
			return errNotVerified
		}
		err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE organization_domains SET verified_at = now() WHERE org_id = $1 AND domain = $2`,
				actor.Org.ID, domain); err != nil {
				return err
			}
			ev := audit.FromRequest(r, "org.domain_verified")
			ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
			ev.TargetType, ev.TargetID = "domain", domain
			ev.Metadata = map[string]any{"domain": domain}
			return audit.Record(ctx, tx, ev)
		})
		if err != nil {
			return err
		}
	}
	return s.ListDomains(w, r)
}

func (s *Service) hasRecord(ctx context.Context, domain, want string) bool {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for _, name := range []string{"_fudislte-verification." + domain, domain} {
		records, err := s.lookupTXT(ctx, name)
		if err != nil {
			continue
		}
		if slices.ContainsFunc(records, func(r string) bool { return strings.TrimSpace(r) == want }) {
			return true
		}
	}
	return false
}
