package org

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
	"fudislte/api/internal/mail"
)

const invitationTTL = 7 * 24 * time.Hour

type Invitation struct {
	ID        uuid.UUID `json:"id"`
	Email     string    `json:"email"`
	Role      RoleRef   `json:"role"`
	InvitedBy string    `json:"invitedBy"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

var errInvitationInvalid = httpx.NewError(http.StatusNotFound, "invitation_invalid", "This invitation link is invalid or has expired.")

func (s *Service) ListInvitations(w http.ResponseWriter, r *http.Request) error {
	m := mustMembership(r.Context())
	rows, err := s.db.Query(r.Context(), `
		SELECT i.id, i.email, r.id, r.key, r.name, r.position, coalesce(u.display_name, ''), i.created_at, i.expires_at
		FROM invitations i
		JOIN roles r ON r.id = i.role_id
		LEFT JOIN users u ON u.id = i.invited_by
		WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
		ORDER BY i.created_at DESC`, m.Org.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	invitations := []Invitation{}
	for rows.Next() {
		var inv Invitation
		if err := rows.Scan(&inv.ID, &inv.Email, &inv.Role.ID, &inv.Role.Key, &inv.Role.Name, &inv.Role.Position,
			&inv.InvitedBy, &inv.CreatedAt, &inv.ExpiresAt); err != nil {
			return err
		}
		invitations = append(invitations, inv)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"invitations": invitations})
	return nil
}

// CreateInvitation issues a single-use invitation link. The raw token is returned once;
// only its hash is stored. A new invitation supersedes a pending one for the same email.
func (s *Service) CreateInvitation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	if !s.invitationsByActor.Allow(actor.UserID.String()) {
		return httpx.ErrRateLimited
	}
	var in struct {
		Email  string    `json:"email"`
		RoleID uuid.UUID `json:"roleId"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	email := auth.NormalizeEmail(in.Email)
	if email == "" {
		return httpx.Invalid(map[string]string{"email": "Enter a valid email address."})
	}

	token, hash := auth.NewToken()
	inv := Invitation{ID: uuid.Must(uuid.NewV7()), Email: email}
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
		var member bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2)`,
			actor.Org.ID, email).Scan(&member); err != nil {
			return err
		}
		if member {
			return httpx.Invalid(map[string]string{"email": "This person is already a member."})
		}
		if _, err := tx.Exec(ctx, `
			UPDATE invitations SET revoked_at = now()
			WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, actor.Org.ID, email); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO invitations (id, org_id, email, role_id, token_hash, invited_by, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING created_at, expires_at`,
			inv.ID, actor.Org.ID, email, role.ID, hash, actor.UserID, time.Now().Add(invitationTTL)).
			Scan(&inv.CreatedAt, &inv.ExpiresAt); err != nil {
			return err
		}
		inv.Role = RoleRef{ID: role.ID, Key: role.Key, Name: role.Name, Position: role.Position}
		if err := tx.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1`, actor.UserID).Scan(&inv.InvitedBy); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "invitation.created")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "invitation", inv.ID.String()
		ev.Metadata = map[string]any{"email": email, "role": role.Name}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	msg := mail.Invitation(i18n.FromContext(ctx), email, actor.Org.Name, inv.InvitedBy, inv.Role.Name, s.publicURL+"/invite/"+token, inv.ExpiresAt)
	s.outbox.Enqueue(func(context.Context) (*mail.Message, error) { return &msg, nil })
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"invitation": inv, "token": token, "emailQueued": true})
	return nil
}

func (s *Service) RevokeInvitation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	invID, err := uuid.Parse(chi.URLParam(r, "invitationID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var email string
		err := tx.QueryRow(ctx, `
			UPDATE invitations SET revoked_at = now()
			WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
			RETURNING email`, invID, actor.Org.ID).Scan(&email)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.ErrNotFound
		}
		if err != nil {
			return err
		}
		ev := audit.FromRequest(r, "invitation.revoked")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "invitation", invID.String()
		ev.Metadata = map[string]any{"email": email}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

func invitationToken(r *http.Request) (string, bool) {
	t := chi.URLParam(r, "token")
	return t, t != "" && len(t) <= 128
}

// PreviewInvitation is public: possession of the token is the credential.
func (s *Service) PreviewInvitation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if !s.invitationsByIP.Allow(httpx.RateKey(httpx.ClientIP(ctx))) {
		return httpx.ErrRateLimited
	}
	token, ok := invitationToken(r)
	if !ok {
		return errInvitationInvalid
	}
	var out struct {
		Email        string    `json:"email"`
		Organization string    `json:"organizationName"`
		Role         string    `json:"roleName"`
		ExpiresAt    time.Time `json:"expiresAt"`
		AccountExist bool      `json:"accountExists"`
	}
	err := s.db.QueryRow(ctx, `
		SELECT i.email, o.name, r.name, i.expires_at
		FROM invitations i
		JOIN organizations o ON o.id = i.org_id
		JOIN roles r ON r.id = i.role_id
		WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
		auth.HashToken(token)).Scan(&out.Email, &out.Organization, &out.Role, &out.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return errInvitationInvalid
	}
	if err != nil {
		return err
	}
	if out.AccountExist, err = auth.UserExists(ctx, s.db, out.Email); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"invitation": out})
	return nil
}

type pendingInvitation struct {
	email   string
	orgName string
}

func (s *Service) findPendingInvitation(ctx context.Context, token string) (*pendingInvitation, error) {
	var p pendingInvitation
	err := s.db.QueryRow(ctx, `
		SELECT i.email, o.name FROM invitations i JOIN organizations o ON o.id = i.org_id
		WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
		auth.HashToken(token)).Scan(&p.email, &p.orgName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInvitationInvalid
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

var errSignInRequired = httpx.NewError(http.StatusConflict, "sign_in_required",
	"An account already exists for this email. Sign in to accept the invitation.")

// RequestInvitationCode emails a one-time code to the invited address so a new person
// proves they own it. The invitation link alone is not enough: links get forwarded.
func (s *Service) RequestInvitationCode(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if !s.invitationsByIP.Allow(httpx.RateKey(httpx.ClientIP(ctx))) {
		return httpx.ErrRateLimited
	}
	token, ok := invitationToken(r)
	if !ok {
		return errInvitationInvalid
	}
	inv, err := s.findPendingInvitation(ctx, token)
	if err != nil {
		return err
	}
	if !s.invitationCodesByEmail.Allow(inv.email) {
		return httpx.ErrRateLimited
	}
	exists, err := auth.UserExists(ctx, s.db, inv.email)
	if err != nil {
		return err
	}
	if exists {
		return errSignInRequired
	}
	code, err := auth.IssueCode(ctx, s.db, inv.email, auth.PurposeInvitation, httpx.ClientIP(ctx))
	if err != nil {
		return err
	}
	if err := s.outbox.SendNow(ctx, mail.InvitationCode(i18n.FromContext(ctx), inv.email, code, inv.orgName)); err != nil {
		slog.ErrorContext(ctx, "sending invitation code failed", "error", err)
		return errMailFailed
	}
	httpx.WriteJSON(w, http.StatusAccepted, map[string]any{})
	return nil
}

var errMailFailed = httpx.NewError(http.StatusBadGateway, "mail_failed", "The server could not send the email. Try again later or contact your administrator.")

// AcceptInvitation joins the invited email to the organization. A signed-in caller must
// own the invited email. Without a session, a new account is created after the person
// enters the code emailed by RequestInvitationCode; if an account already exists the
// caller must sign in first.
func (s *Service) AcceptInvitation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if !s.invitationsByIP.Allow(httpx.RateKey(httpx.ClientIP(ctx))) {
		return httpx.ErrRateLimited
	}
	token, ok := invitationToken(r)
	if !ok {
		return errInvitationInvalid
	}
	var in struct {
		DisplayName string `json:"displayName"`
		Code        string `json:"code"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	identity := auth.IdentityFrom(ctx)
	if identity == nil {
		// Validate everything else before spending a code attempt.
		if _, msg := auth.NormalizeDisplayName(in.DisplayName); msg != "" {
			return httpx.Invalid(map[string]string{"displayName": msg})
		}
		inv, err := s.findPendingInvitation(ctx, token)
		if err != nil {
			return err
		}
		if err := s.auth.VerifyCode(ctx, inv.email, auth.PurposeInvitation, in.Code); err != nil {
			return err
		}
	}

	var (
		o            Organization
		sessionToken string
	)
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var (
			invID, orgID, roleID uuid.UUID
			email                string
		)
		err := tx.QueryRow(ctx, `
			SELECT id, org_id, email, role_id FROM invitations
			WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
			FOR UPDATE`, auth.HashToken(token)).Scan(&invID, &orgID, &email, &roleID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errInvitationInvalid
		}
		if err != nil {
			return err
		}

		var userID uuid.UUID
		newAccount := identity == nil
		if identity != nil {
			if identity.User.Email != email {
				return httpx.NewError(http.StatusForbidden, "invitation_email_mismatch",
					"This invitation was sent to a different email address. Sign out and open the link again.")
			}
			userID = identity.User.ID
		} else {
			exists, err := auth.UserExists(ctx, tx, email)
			if err != nil {
				return err
			}
			if exists {
				return errSignInRequired
			}
			u, err := s.auth.CreateUser(ctx, tx, auth.NewUser{Email: email, DisplayName: in.DisplayName, Locale: i18n.FromContext(ctx)})
			if err != nil {
				return err
			}
			userID = u.ID
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO memberships (org_id, user_id, role_id) VALUES ($1, $2, $3)
			ON CONFLICT (org_id, user_id) DO NOTHING`, orgID, userID, roleID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, invID, userID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "invitation.accepted")
		ev.OrgID, ev.ActorID = &orgID, &userID
		ev.TargetType, ev.TargetID = "invitation", invID.String()
		ev.Metadata = map[string]any{"email": email, "newAccount": newAccount}
		if err := audit.Record(ctx, tx, ev); err != nil {
			return err
		}
		if newAccount {
			if sessionToken, err = s.auth.CreateSession(ctx, tx, r, userID); err != nil {
				return err
			}
		}
		return tx.QueryRow(ctx, `SELECT id, name, slug, created_at FROM organizations WHERE id = $1`, orgID).
			Scan(&o.ID, &o.Name, &o.Slug, &o.CreatedAt)
	})
	if err != nil {
		return err
	}
	if sessionToken != "" {
		s.auth.SetSessionCookie(w, sessionToken)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"organization": o})
	return nil
}
