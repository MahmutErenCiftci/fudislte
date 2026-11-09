// Package setup serves instance metadata and the one-time first-run setup that creates
// the instance administrator and the first workspace.
package setup

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
	"fudislte/api/internal/mail"
	"fudislte/api/internal/org"
	"fudislte/api/internal/registration"
)

type Service struct {
	db        *pgxpool.Pool
	auth      *auth.Service
	outbox    *mail.Outbox
	publicURL string
	version   string
	token     string
	limiter   *httpx.Limiter
	reg       *registration.Service
}

type Options struct {
	Version   string
	PublicURL string
	// Token is the operator-configured setup token; empty generates one.
	Token string
	// Registration lets the new owner opt in to registering the server during setup.
	Registration *registration.Service
}

// New prepares the setup service. When the instance has no users and no token was
// configured, a random token is generated and written to the log: an operator with
// access to the server log is the only party who can complete setup.
func New(ctx context.Context, db *pgxpool.Pool, authSvc *auth.Service, outbox *mail.Outbox, opts Options) (*Service, error) {
	s := &Service{
		db: db, auth: authSvc, outbox: outbox, publicURL: opts.PublicURL, version: opts.Version, token: opts.Token,
		limiter: httpx.NewLimiter(6*time.Second, 10), reg: opts.Registration,
	}
	required, err := s.required(ctx, db)
	if err != nil {
		return nil, err
	}
	if required && s.token == "" {
		b := make([]byte, 18)
		_, _ = rand.Read(b)
		s.token = base64.RawURLEncoding.EncodeToString(b)
		slog.Warn("FUDISLTE is not set up yet. Open the web app and enter this one-time setup token.", "setup_token", s.token)
	}
	return s, nil
}

func (s *Service) required(ctx context.Context, q database.Querier) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users)`).Scan(&exists)
	return !exists, err
}

func (s *Service) Meta(w http.ResponseWriter, r *http.Request) error {
	required, err := s.required(r.Context(), s.db)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"product":       "fudislte",
		"version":       s.version,
		"setupRequired": required,
		// Whether setup offers to register the server with the FUDISLTE project.
		"registrationAvailable": s.reg != nil && s.reg.Available(),
	})
	return nil
}

var errAlreadySetUp = httpx.NewError(http.StatusConflict, "already_set_up", "This FUDISLTE instance is already set up.")

// checkToken rate-limits setup attempts and verifies the setup token.
func (s *Service) checkToken(r *http.Request, token string) error {
	if !s.limiter.Allow(httpx.RateKey(httpx.ClientIP(r.Context()))) {
		return httpx.ErrRateLimited
	}
	required, err := s.required(r.Context(), s.db)
	if err != nil {
		return err
	}
	if !required || s.token == "" {
		return errAlreadySetUp
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) != 1 {
		return httpx.Invalid(map[string]string{"setupToken": "The setup token is not correct. Check the API server log."})
	}
	return nil
}

// RequestCode sends a confirmation code to the future owner. Delivery is synchronous:
// setup must not finish on a server that cannot send sign-in codes.
func (s *Service) RequestCode(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		SetupToken string `json:"setupToken"`
		Email      string `json:"email"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if err := s.checkToken(r, in.SetupToken); err != nil {
		return err
	}
	ctx := r.Context()
	email := auth.NormalizeEmail(in.Email)
	if email == "" {
		return httpx.Invalid(map[string]string{"email": "Enter a valid email address."})
	}
	code, err := auth.IssueCode(ctx, s.db, email, auth.PurposeSetup, httpx.ClientIP(ctx))
	if err != nil {
		return err
	}
	if err := s.outbox.SendNow(ctx, mail.SetupCode(i18n.FromContext(ctx), email, code, s.publicURL)); err != nil {
		slog.ErrorContext(ctx, "sending setup code failed", "error", err)
		return httpx.NewError(http.StatusBadGateway, "mail_failed",
			"The server could not send email. Check the FUDISLTE_SMTP_* settings and the API log, then try again.")
	}
	httpx.WriteJSON(w, http.StatusAccepted, map[string]any{})
	return nil
}

func (s *Service) Complete(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		SetupToken       string `json:"setupToken"`
		OrganizationName string `json:"organizationName"`
		DisplayName      string `json:"displayName"`
		Email            string `json:"email"`
		Code             string `json:"code"`
		// ShareRegistration is the owner's explicit consent to register the server:
		// workspace name, their email, number of users and version (package registration).
		ShareRegistration bool `json:"shareRegistration"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if err := s.checkToken(r, in.SetupToken); err != nil {
		return err
	}
	ctx := r.Context()

	// Validate everything before spending a code attempt.
	fields := map[string]string{}
	email := auth.NormalizeEmail(in.Email)
	if email == "" {
		fields["email"] = "Enter a valid email address."
	}
	if _, msg := auth.NormalizeDisplayName(in.DisplayName); msg != "" {
		fields["displayName"] = msg
	}
	if _, msg := org.NormalizeName(in.OrganizationName); msg != "" {
		fields["organizationName"] = msg
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	if err := s.auth.VerifyCode(ctx, email, auth.PurposeSetup, in.Code); err != nil {
		return err
	}

	var (
		user  auth.User
		o     org.Organization
		token string
	)
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		// Serialize concurrent setup attempts; only the first can succeed.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('fudislte.instance_setup'))`); err != nil {
			return err
		}
		required, err := s.required(ctx, tx)
		if err != nil {
			return err
		}
		if !required {
			return errAlreadySetUp
		}
		if user, err = s.auth.CreateUser(ctx, tx, auth.NewUser{Email: email, DisplayName: in.DisplayName, Locale: i18n.FromContext(ctx), IsInstanceAdmin: true}); err != nil {
			return err
		}
		if o, err = org.CreateOrganization(ctx, tx, in.OrganizationName, user.ID); err != nil {
			return err
		}
		if token, err = s.auth.CreateSession(ctx, tx, r, user.ID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "instance.setup_completed")
		ev.OrgID, ev.ActorID = &o.ID, &user.ID
		ev.TargetType, ev.TargetID = "organization", o.ID.String()
		if err := audit.Record(ctx, tx, ev); err != nil {
			return err
		}
		if in.ShareRegistration && s.reg != nil && s.reg.Available() {
			return s.reg.Enable(ctx, tx, r, user.ID, o.Name, user.Email)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if in.ShareRegistration && s.reg != nil {
		s.reg.Wake()
	}
	s.auth.SetSessionCookie(w, token)
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"user": user, "organization": o})
	return nil
}
