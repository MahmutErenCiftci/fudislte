// Package login signs people in with one-time codes sent to their work email.
//
// Requesting a code always gets the same response, sent before any lookup happens, so
// callers cannot learn which addresses have accounts. A code is only issued to an
// existing active account or to an address whose domain a workspace accepts; the
// latter becomes a new account on first sign-in (ADR-0006).
package login

import (
	"context"
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
)

type Service struct {
	db        *pgxpool.Pool
	auth      *auth.Service
	outbox    *mail.Outbox
	publicURL string

	requestByIP    *httpx.Limiter
	requestByEmail *httpx.Limiter
	verifyByIP     *httpx.Limiter
}

func NewService(db *pgxpool.Pool, authSvc *auth.Service, outbox *mail.Outbox, publicURL string) *Service {
	return &Service{
		db:        db,
		auth:      authSvc,
		outbox:    outbox,
		publicURL: publicURL,
		// At most ~6 codes per address per hour after a burst of 3; with 5 guesses per
		// code this bounds online guessing of 8-digit codes.
		requestByIP:    httpx.NewLimiter(30*time.Second, 10),
		requestByEmail: httpx.NewLimiter(10*time.Minute, 3),
		verifyByIP:     httpx.NewLimiter(3*time.Second, 20),
	}
}

// RequestCode emails a sign-in code if the address may sign in, and responds the same
// way either way.
func (s *Service) RequestCode(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email string `json:"email"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	email := auth.NormalizeEmail(in.Email)
	if email == "" {
		return httpx.Invalid(map[string]string{"email": "Enter a valid email address."})
	}
	ip := httpx.ClientIP(ctx)
	requestLocale := i18n.FromContext(ctx)
	if !s.requestByIP.Allow(httpx.RateKey(ip)) || !s.requestByEmail.Allow(email) {
		return httpx.ErrRateLimited
	}
	s.outbox.Enqueue(func(ctx context.Context) (*mail.Message, error) {
		user, disabled, err := auth.FindUser(ctx, s.db, email)
		if err != nil {
			return nil, err
		}
		eligible := user != nil && !disabled
		if user == nil {
			matches, err := org.DomainMatches(ctx, s.db, email)
			if err != nil {
				return nil, err
			}
			eligible = len(matches) > 0
		}
		if !eligible {
			return nil, nil
		}
		code, err := auth.IssueCode(ctx, s.db, email, auth.PurposeLogin, ip)
		if err != nil {
			return nil, err
		}
		locale := requestLocale
		if user != nil {
			if l, ok := i18n.Parse(user.Locale); ok {
				locale = l
			}
		}
		m := mail.LoginCode(locale, email, code, s.publicURL)
		return &m, nil
	})
	httpx.WriteJSON(w, http.StatusAccepted, map[string]any{})
	return nil
}

var errNoAccess = httpx.NewError(http.StatusForbidden, "no_access",
	"This email address does not have access to FUDISLTE. Ask an administrator to invite you.")

// VerifyCode exchanges a valid code for a session. First-time sign-ins from an accepted
// domain create the account and join the matching workspaces.
func (s *Service) VerifyCode(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if !s.verifyByIP.Allow(httpx.RateKey(httpx.ClientIP(ctx))) {
		return httpx.ErrRateLimited
	}
	email := auth.NormalizeEmail(in.Email)
	if email == "" {
		return auth.ErrInvalidCode
	}
	if err := s.auth.VerifyCode(ctx, email, auth.PurposeLogin, in.Code); err != nil {
		return err
	}

	var (
		user       auth.User
		newAccount bool
		token      string
	)
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		existing, disabled, err := auth.FindUser(ctx, tx, email)
		if err != nil {
			return err
		}
		switch {
		case existing != nil && disabled:
			return httpx.NewError(http.StatusForbidden, "account_disabled", "This account is disabled. Contact your administrator.")
		case existing != nil:
			user = *existing
		default:
			matches, err := org.DomainMatches(ctx, tx, email)
			if err != nil {
				return err
			}
			if len(matches) == 0 {
				return errNoAccess
			}
			if user, err = s.auth.CreateUser(ctx, tx, auth.NewUser{Email: email, DisplayName: auth.NameFromEmail(email), Locale: i18n.FromContext(ctx)}); err != nil {
				return err
			}
			if err := org.JoinByDomain(ctx, tx, r, user.ID, matches); err != nil {
				return err
			}
			newAccount = true
		}
		if token, err = s.auth.CreateSession(ctx, tx, r, user.ID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "auth.login")
		ev.ActorID = &user.ID
		ev.Metadata = map[string]any{"method": "email_code", "newAccount": newAccount}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.auth.SetSessionCookie(w, token)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": user, "newAccount": newAccount})
	return nil
}
