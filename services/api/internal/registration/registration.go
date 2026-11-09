// Package registration tells the FUDISLTE project that this server exists — only when an
// instance administrator agrees to it. A report carries the organization name and
// contact email the administrator entered, the number of active accounts and the
// version, and nothing else; it is sent once a day so the count stays current, and
// turning registration off withdraws the record. The registry's address comes from
// FUDISLTE_REGISTRY_URL or the build's default; without one the option is not offered.
package registration

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
)

const (
	reportEvery = 24 * time.Hour
	retryAfter  = time.Hour
)

type Service struct {
	db      *pgxpool.Pool
	url     string
	version string
	client  *http.Client
	wake    chan struct{}
}

// New prepares the reporter; url is the registry's base URL, empty when there is none.
func New(db *pgxpool.Pool, url, version string) *Service {
	return &Service{db: db, url: url, version: version, client: &http.Client{Timeout: 15 * time.Second}, wake: make(chan struct{}, 1)}
}

// Available reports whether this server knows a registry to report to.
func (s *Service) Available() bool { return s.url != "" }

// Wake asks the reporter to sync now, for example after the settings changed.
func (s *Service) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Settings is what instance administrators see: whether registration is on and exactly
// what a report contains.
type Settings struct {
	Available        bool       `json:"available"`
	Enabled          bool       `json:"enabled"`
	OrganizationName string     `json:"organizationName"`
	ContactEmail     string     `json:"contactEmail"`
	UserCount        int        `json:"userCount"`
	Version          string     `json:"version"`
	LastSentAt       *time.Time `json:"lastSentAt"`
	LastError        string     `json:"lastError"`
}

type state struct {
	enabled    bool
	instanceID uuid.UUID
	name       string
	email      string
	secret     string
	sentAt     *time.Time
}

func load(ctx context.Context, q database.Querier) (state, error) {
	var st state
	err := q.QueryRow(ctx, `
		SELECT registration_enabled, instance_id, registration_name, registration_email, registration_secret, registration_sent_at
		FROM instance_settings`).Scan(&st.enabled, &st.instanceID, &st.name, &st.email, &st.secret, &st.sentAt)
	return st, err
}

func userCount(ctx context.Context, q database.Querier) (int, error) {
	var n int
	err := q.QueryRow(ctx, `SELECT count(*) FROM users WHERE disabled_at IS NULL`).Scan(&n)
	return n, err
}

func newSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

var errUnavailable = httpx.NewError(http.StatusConflict, "registration_unavailable", "Registration is not available on this server.")

// validate normalizes the name and email an administrator agreed to share.
func validate(name, email string) (string, string, error) {
	fields := map[string]string{}
	n, msg := org.NormalizeName(name)
	if msg != "" {
		fields["organizationName"] = msg
	}
	e := auth.NormalizeEmail(email)
	if e == "" {
		fields["contactEmail"] = "Enter a valid email address."
	}
	if len(fields) > 0 {
		return "", "", httpx.Invalid(fields)
	}
	return n, e, nil
}

// Enable turns registration on inside q (used by first-run setup). Call Wake after the
// transaction commits.
func (s *Service) Enable(ctx context.Context, q database.Querier, r *http.Request, actorID uuid.UUID, name, email string) error {
	if !s.Available() {
		return errUnavailable
	}
	name, email, err := validate(name, email)
	if err != nil {
		return err
	}
	if _, err := q.Exec(ctx, `
		UPDATE instance_settings
		SET registration_enabled = true, registration_name = $1, registration_email = $2,
		    registration_secret = CASE WHEN registration_secret = '' THEN $3 ELSE registration_secret END,
		    registration_error = '', updated_by = $4, updated_at = now()`,
		name, email, newSecret(), actorID); err != nil {
		return err
	}
	ev := audit.FromRequest(r, "instance.registration_enabled")
	ev.ActorID = &actorID
	ev.Metadata = map[string]any{"organizationName": name, "contactEmail": email}
	return audit.Record(ctx, q, ev)
}

func requireInstanceAdmin(r *http.Request) (*auth.Identity, error) {
	id := auth.MustIdentity(r.Context())
	if !id.User.IsInstanceAdmin {
		return nil, httpx.ErrForbidden
	}
	return id, nil
}

func (s *Service) settings(ctx context.Context) (Settings, error) {
	out := Settings{Available: s.Available(), Version: s.version}
	err := s.db.QueryRow(ctx, `
		SELECT registration_enabled, registration_name, registration_email, registration_sent_at, registration_error
		FROM instance_settings`).Scan(&out.Enabled, &out.OrganizationName, &out.ContactEmail, &out.LastSentAt, &out.LastError)
	if err != nil {
		return out, err
	}
	out.UserCount, err = userCount(ctx, s.db)
	return out, err
}

func (s *Service) Get(w http.ResponseWriter, r *http.Request) error {
	if _, err := requireInstanceAdmin(r); err != nil {
		return err
	}
	out, err := s.settings(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"registration": out})
	return nil
}

// Update turns registration on (with the name and email to share) or off. Turning it off
// withdraws the record from the registry.
func (s *Service) Update(w http.ResponseWriter, r *http.Request) error {
	id, err := requireInstanceAdmin(r)
	if err != nil {
		return err
	}
	var in struct {
		Enabled          bool   `json:"enabled"`
		OrganizationName string `json:"organizationName"`
		ContactEmail     string `json:"contactEmail"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if in.Enabled {
			return s.Enable(ctx, tx, r, id.User.ID, in.OrganizationName, in.ContactEmail)
		}
		tag, err := tx.Exec(ctx, `
			UPDATE instance_settings SET registration_enabled = false, registration_error = '', updated_by = $1, updated_at = now()
			WHERE registration_enabled`, id.User.ID)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		ev := audit.FromRequest(r, "instance.registration_disabled")
		ev.ActorID = &id.User.ID
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.Wake()
	out, err := s.settings(ctx)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"registration": out})
	return nil
}

// Run reports shortly after start-up, then daily and whenever Wake is called, until ctx
// ends. A failed attempt is retried after an hour.
func (s *Service) Run(ctx context.Context) {
	if !s.Available() {
		return
	}
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-s.wake:
		}
		next := reportEvery
		if err := s.sync(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.WarnContext(ctx, "registration report failed", "error", err)
			next = retryAfter
		}
		timer.Reset(next)
	}
}

// sync sends a report while registration is on, and withdraws the record once after it
// was turned off.
func (s *Service) sync(ctx context.Context) error {
	st, err := load(ctx, s.db)
	if err != nil {
		return err
	}
	var sendErr error
	switch {
	case st.enabled:
		sendErr = s.report(ctx, st)
	case st.sentAt != nil:
		sendErr = s.withdraw(ctx, st)
	default:
		return nil
	}
	msg := ""
	if sendErr != nil {
		msg = sendErr.Error()
		if len(msg) > 300 {
			msg = msg[:300]
		}
	}
	// A successful report sets sent_at, a successful withdrawal clears it. The outcome is
	// only recorded if nobody switched the setting meanwhile.
	if _, err := s.db.Exec(ctx, `
		UPDATE instance_settings
		SET registration_error = $2,
		    registration_sent_at = CASE WHEN NOT $3::boolean THEN registration_sent_at WHEN $1::boolean THEN now() END
		WHERE registration_enabled = $1`, st.enabled, msg, sendErr == nil); err != nil {
		return err
	}
	return sendErr
}

func (s *Service) report(ctx context.Context, st state) error {
	users, err := userCount(ctx, s.db)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{
		"instanceId":       st.instanceID.String(),
		"secret":           st.secret,
		"organizationName": st.name,
		"contactEmail":     st.email,
		"userCount":        users,
		"version":          s.version,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url+"/v1/instances", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return s.do(req)
}

func (s *Service) withdraw(ctx context.Context, st state) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, s.url+"/v1/instances/"+st.instanceID.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+st.secret)
	return s.do(req)
}

func (s *Service) do(req *http.Request) error {
	req.Header.Set("User-Agent", "fudislte/"+s.version)
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("registry answered %d: %s", resp.StatusCode, bytes.TrimSpace(b))
	}
	return nil
}
