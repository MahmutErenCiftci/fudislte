package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/config"
	"fudislte/api/internal/database"
	"fudislte/api/internal/i18n"
	"fudislte/api/internal/mail"
	"fudislte/api/internal/mail/mailtest"
	"fudislte/api/internal/realtime"
	"fudislte/api/internal/server"
	"fudislte/api/internal/testutil"
)

func TestMain(m *testing.M) { testutil.Main(m) }

const (
	setupToken = "integration-test-setup-token"
	ownerEmail = "owner@example.com"
	publicURL  = "https://fudislte.test"
)

type testServer struct {
	t    *testing.T
	url  string
	mail *mailtest.Recorder
	db   *pgxpool.Pool
	cfg  config.Config
	dns  *fakeDNS
	lk   *fakeLiveKit
}

// fakeDNS answers TXT lookups for domain verification.
type fakeDNS struct {
	mu      sync.Mutex
	records map[string][]string
}

func (d *fakeDNS) set(name string, records ...string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.records[name] = records
}

func (d *fakeDNS) lookup(_ context.Context, name string) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if r, ok := d.records[name]; ok {
		return r, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
}

// newServer starts the API on a fresh database; options adjust its dependencies.
func newServer(t *testing.T, options ...func(*server.Deps)) *testServer {
	t.Helper()
	dbURL := testutil.NewDatabase(t)
	pool, err := database.Connect(t.Context(), dbURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cfg := config.Config{
		PublicURL:      publicURL,
		CookieSecure:   false,
		SetupToken:     setupToken,
		SessionIdleTTL: time.Hour,
		DefaultLocale:  i18n.Turkish,
		DataDir:        t.TempDir(),
		MaxUploadBytes: 1 << 20,
	}
	recorder := &mailtest.Recorder{}
	outbox := mail.NewOutbox(recorder)
	t.Cleanup(func() { outbox.Wait(t.Context()) })
	// A short grace period so tests see people go offline quickly.
	hub := realtime.NewHub(realtime.WithPresenceGrace(200 * time.Millisecond))
	t.Cleanup(hub.Close)
	dns := &fakeDNS{records: map[string][]string{}}
	lk := newFakeLiveKit(t)
	cfg.Media = config.Media{URL: "ws://livekit.test", APIURL: lk.url, APIKey: "devkey", APISecret: liveKitSecret}
	deps := server.Deps{DB: pool, Config: cfg, Version: "test", Outbox: outbox, Hub: hub, LookupTXT: dns.lookup}
	for _, option := range options {
		option(&deps)
	}
	h, err := server.New(t.Context(), deps)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return &testServer{t: t, url: ts.URL, mail: recorder, db: pool, cfg: cfg, dns: dns, lk: lk}
}

// client is a cookie-keeping API client, i.e. one browser.
type client struct {
	t    *testing.T
	base string
	hc   *http.Client
}

func (ts *testServer) client() *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: ts.t, base: ts.url, hc: &http.Client{Jar: jar}}
}

type response struct {
	status int
	body   []byte
}

func (c *client) request(method, path string, body any, header http.Header) response {
	c.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		c.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return response{status: resp.StatusCode, body: b}
}

func (c *client) do(method, path string, body any) response {
	c.t.Helper()
	return c.request(method, path, body, nil)
}

// must performs a request and fails the test unless the status matches.
func (c *client) must(want int, method, path string, body any) response {
	c.t.Helper()
	r := c.do(method, path, body)
	if r.status != want {
		c.t.Fatalf("%s %s: status %d, want %d; body: %s", method, path, r.status, want, r.body)
	}
	return r
}

func (r response) decode(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("decode %s: %v", r.body, err)
	}
}

type apiError struct {
	Error struct {
		Code   string            `json:"code"`
		Fields map[string]string `json:"fields"`
	} `json:"error"`
}

func (r response) errCode(t *testing.T) string {
	t.Helper()
	var e apiError
	r.decode(t, &e)
	return e.Error.Code
}

func expectError(t *testing.T, r response, status int, code string) {
	t.Helper()
	if r.status != status {
		t.Fatalf("status %d, want %d; body: %s", r.status, status, r.body)
	}
	if got := r.errCode(t); got != code {
		t.Fatalf("error code %q, want %q; body: %s", got, code, r.body)
	}
}

type role struct {
	ID          string   `json:"id"`
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Position    int      `json:"position"`
	Permissions []string `json:"permissions"`
	IsSystem    bool     `json:"isSystem"`
	MemberCount int      `json:"memberCount"`
}

type me struct {
	User struct {
		ID              string `json:"id"`
		Email           string `json:"email"`
		DisplayName     string `json:"displayName"`
		Locale          string `json:"locale"`
		IsInstanceAdmin bool   `json:"isInstanceAdmin"`
	} `json:"user"`
	Workspaces []struct {
		Organization struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Slug string `json:"slug"`
		} `json:"organization"`
		Role role `json:"role"`
	} `json:"workspaces"`
}

func (c *client) me() me {
	c.t.Helper()
	var m me
	c.must(http.StatusOK, http.MethodGet, "/api/v1/me", nil).decode(c.t, &m)
	return m
}

// setupInstance completes first-run setup and returns the owner's client and org ID.
func (ts *testServer) setupInstance() (*client, string) {
	ts.t.Helper()
	owner := ts.client()
	owner.must(http.StatusAccepted, http.MethodPost, "/api/v1/setup/code", map[string]string{"setupToken": setupToken, "email": ownerEmail})
	code := mailtest.Code(ts.t, ts.mail.Next(ts.t, ownerEmail, "setup_code"))
	var out struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/setup", map[string]string{
		"setupToken":       setupToken,
		"organizationName": "Acme Şirketi",
		"displayName":      "Alex Owner",
		"email":            ownerEmail,
		"code":             code,
	}).decode(ts.t, &out)
	return owner, out.Organization.ID
}

// requestCode asks for a sign-in code and returns it from the delivered email.
func (ts *testServer) requestCode(c *client, email string) string {
	ts.t.Helper()
	c.must(http.StatusAccepted, http.MethodPost, "/api/v1/auth/code", map[string]string{"email": email})
	return mailtest.Code(ts.t, ts.mail.Next(ts.t, email, "login_code"))
}

// signIn returns a new client signed in as email through the email-code flow.
func (ts *testServer) signIn(email string) *client {
	ts.t.Helper()
	c := ts.client()
	code := ts.requestCode(c, email)
	c.must(http.StatusOK, http.MethodPost, "/api/v1/auth/verify", map[string]string{"email": email, "code": code})
	return c
}

func (c *client) roles(orgID string) map[string]role {
	c.t.Helper()
	var out struct {
		Roles []role `json:"roles"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/roles", nil).decode(c.t, &out)
	byKey := map[string]role{}
	for _, r := range out.Roles {
		byKey[r.Key] = r
	}
	return byKey
}

func (c *client) invite(orgID, email, roleID string) string {
	c.t.Helper()
	var out struct {
		Token string `json:"token"`
	}
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/invitations",
		map[string]string{"email": email, "roleId": roleID}).decode(c.t, &out)
	return out.Token
}

// join invites email with roleKey and accepts the invitation as a new account.
func (ts *testServer) join(inviter *client, orgID, email, roleKey string) (*client, string) {
	ts.t.Helper()
	token := inviter.invite(orgID, email, inviter.roles(orgID)[roleKey].ID)
	c := ts.client()
	code := ts.invitationCode(c, token, email)
	c.must(http.StatusOK, http.MethodPost, "/api/v1/invitations/"+token+"/accept",
		map[string]string{"displayName": "User " + roleKey, "code": code})
	return c, c.me().User.ID
}

func (ts *testServer) invitationCode(c *client, token, email string) string {
	ts.t.Helper()
	c.must(http.StatusAccepted, http.MethodPost, "/api/v1/invitations/"+token+"/code", nil)
	return mailtest.Code(ts.t, ts.mail.Next(ts.t, email, "invitation_code"))
}
