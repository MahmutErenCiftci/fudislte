package server_test

import (
	"net/http"
	"testing"
	"time"

	"fudislte/api/internal/mail/mailtest"
)

func TestSetup(t *testing.T) {
	ts := newServer(t)
	anon := ts.client()

	var meta struct {
		Product       string `json:"product"`
		SetupRequired bool   `json:"setupRequired"`
	}
	anon.must(http.StatusOK, http.MethodGet, "/api/v1/meta", nil).decode(t, &meta)
	if meta.Product != "fudislte" || !meta.SetupRequired {
		t.Fatalf("meta = %+v, want setup required", meta)
	}

	expectError(t, anon.do(http.MethodPost, "/api/v1/setup/code",
		map[string]string{"setupToken": "wrong-token-value", "email": ownerEmail}), http.StatusUnprocessableEntity, "validation_failed")
	ts.mail.None(t, ownerEmail, "setup_code", 50*time.Millisecond)
	expectError(t, anon.do(http.MethodPost, "/api/v1/setup/code",
		map[string]string{"setupToken": setupToken, "email": "not-an-email"}), http.StatusUnprocessableEntity, "validation_failed")

	anon.must(http.StatusAccepted, http.MethodPost, "/api/v1/setup/code", map[string]string{"setupToken": setupToken, "email": ownerEmail})
	code := mailtest.Code(t, ts.mail.Next(t, ownerEmail, "setup_code"))
	body := map[string]string{
		"setupToken": setupToken, "organizationName": "Acme", "displayName": "",
		"email": ownerEmail, "code": code,
	}
	// Field errors are reported before the code is checked, so the code stays usable.
	expectError(t, anon.do(http.MethodPost, "/api/v1/setup", body), http.StatusUnprocessableEntity, "validation_failed")
	body["displayName"], body["code"] = "Alex", "00000000"
	if code == "00000000" {
		body["code"] = "11111111"
	}
	expectError(t, anon.do(http.MethodPost, "/api/v1/setup", body), http.StatusUnauthorized, "invalid_code")
	body["code"] = code
	anon.must(http.StatusCreated, http.MethodPost, "/api/v1/setup", body)

	m := anon.me()
	if !m.User.IsInstanceAdmin || len(m.Workspaces) != 1 || m.Workspaces[0].Role.Key != "owner" || len(m.Workspaces[0].Role.Permissions) != 18 {
		t.Fatalf("me = %+v", m)
	}
	if roles := anon.roles(m.Workspaces[0].Organization.ID); len(roles) != 9 {
		t.Fatalf("expected 9 default roles, got %d", len(roles))
	}

	anon.must(http.StatusOK, http.MethodGet, "/api/v1/meta", nil).decode(t, &meta)
	if meta.SetupRequired {
		t.Fatal("setup still required after completion")
	}
	expectError(t, ts.client().do(http.MethodPost, "/api/v1/setup/code",
		map[string]string{"setupToken": setupToken, "email": "mallory@example.com"}), http.StatusConflict, "already_set_up")
}

func TestSetupCreatesSlugFromName(t *testing.T) {
	ts := newServer(t)
	owner, _ := ts.setupInstance()
	if slug := owner.me().Workspaces[0].Organization.Slug; slug != "acme-sirketi" {
		t.Fatalf("slug = %q", slug)
	}
}

func TestCodeSignInAndSessions(t *testing.T) {
	ts := newServer(t)
	first, _ := ts.setupInstance()

	second := ts.client()
	// Addresses are matched case-insensitively.
	second.must(http.StatusAccepted, http.MethodPost, "/api/v1/auth/code", map[string]string{"email": " Owner@Example.com "})
	code := mailtest.Code(t, ts.mail.Next(t, ownerEmail, "login_code"))
	wrong := "00000000"
	if code == wrong {
		wrong = "11111111"
	}
	expectError(t, second.do(http.MethodPost, "/api/v1/auth/verify", map[string]string{"email": ownerEmail, "code": wrong}),
		http.StatusUnauthorized, "invalid_code")
	expectError(t, second.do(http.MethodGet, "/api/v1/me", nil), http.StatusUnauthorized, "unauthorized")

	var out struct {
		NewAccount bool `json:"newAccount"`
	}
	second.must(http.StatusOK, http.MethodPost, "/api/v1/auth/verify",
		map[string]string{"email": ownerEmail, "code": code[:4] + " " + code[4:]}).decode(t, &out)
	if out.NewAccount {
		t.Fatal("existing owner reported as a new account")
	}

	var sessions struct {
		Sessions []struct {
			Current bool `json:"current"`
		} `json:"sessions"`
	}
	second.must(http.StatusOK, http.MethodGet, "/api/v1/me/sessions", nil).decode(t, &sessions)
	if len(sessions.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %+v", sessions)
	}

	second.must(http.StatusOK, http.MethodDelete, "/api/v1/me/sessions", nil)
	expectError(t, first.do(http.MethodGet, "/api/v1/me", nil), http.StatusUnauthorized, "unauthorized")
	second.must(http.StatusNoContent, http.MethodPost, "/api/v1/auth/logout", nil)
	expectError(t, second.do(http.MethodGet, "/api/v1/me", nil), http.StatusUnauthorized, "unauthorized")
}

func TestCodesAreSingleUseSupersededAndAttemptLimited(t *testing.T) {
	ts := newServer(t)
	ts.setupInstance()
	c := ts.client()
	verify := func(code string) response {
		return c.do(http.MethodPost, "/api/v1/auth/verify", map[string]string{"email": ownerEmail, "code": code})
	}

	older := ts.requestCode(c, ownerEmail)
	newer := ts.requestCode(c, ownerEmail)
	if older != newer {
		expectError(t, verify(older), http.StatusUnauthorized, "invalid_code")
	}
	c.must(http.StatusOK, http.MethodPost, "/api/v1/auth/verify", map[string]string{"email": ownerEmail, "code": newer})
	expectError(t, verify(newer), http.StatusUnauthorized, "invalid_code")

	third := ts.requestCode(c, ownerEmail)
	wrong := "00000000"
	if third == wrong {
		wrong = "11111111"
	}
	for range 5 {
		expectError(t, verify(wrong), http.StatusUnauthorized, "invalid_code")
	}
	// After five failed attempts even the right code no longer works.
	expectError(t, verify(third), http.StatusUnauthorized, "invalid_code")
}

func TestUnknownEmailGetsSameResponseButNoCode(t *testing.T) {
	ts := newServer(t)
	ts.setupInstance()
	c := ts.client()
	c.must(http.StatusAccepted, http.MethodPost, "/api/v1/auth/code", map[string]string{"email": "nobody@example.com"})
	ts.mail.None(t, "nobody@example.com", "login_code", 300*time.Millisecond)
	expectError(t, c.do(http.MethodPost, "/api/v1/auth/verify",
		map[string]string{"email": "nobody@example.com", "code": "12345678"}), http.StatusUnauthorized, "invalid_code")
}

func TestCodeRequestsAreRateLimitedPerEmail(t *testing.T) {
	ts := newServer(t)
	ts.setupInstance()
	c := ts.client()
	for range 3 {
		c.must(http.StatusAccepted, http.MethodPost, "/api/v1/auth/code", map[string]string{"email": ownerEmail})
	}
	expectError(t, c.do(http.MethodPost, "/api/v1/auth/code", map[string]string{"email": ownerEmail}),
		http.StatusTooManyRequests, "rate_limited")
}

func TestUpdateProfile(t *testing.T) {
	ts := newServer(t)
	owner, _ := ts.setupInstance()
	expectError(t, owner.do(http.MethodPatch, "/api/v1/me", map[string]string{"displayName": "   "}),
		http.StatusUnprocessableEntity, "validation_failed")
	owner.must(http.StatusOK, http.MethodPatch, "/api/v1/me", map[string]string{"displayName": "  Alex   Morgan "})
	if got := owner.me().User.DisplayName; got != "Alex Morgan" {
		t.Fatalf("display name = %q", got)
	}
}

func TestCrossOriginStateChangeIsRejected(t *testing.T) {
	ts := newServer(t)
	ts.setupInstance()
	c := ts.client()
	r := c.request(http.MethodPost, "/api/v1/auth/code", map[string]string{"email": ownerEmail},
		http.Header{"Sec-Fetch-Site": {"cross-site"}, "Origin": {"https://evil.example"}})
	expectError(t, r, http.StatusForbidden, "cross_origin_rejected")

	// Safe methods stay available cross-origin; they carry no side effects.
	r = c.request(http.MethodGet, "/api/v1/meta", nil, http.Header{"Sec-Fetch-Site": {"cross-site"}})
	if r.status != http.StatusOK {
		t.Fatalf("GET meta cross-site: %d", r.status)
	}
}

func TestRejectsUnknownJSONFields(t *testing.T) {
	ts := newServer(t)
	expectError(t, ts.client().do(http.MethodPost, "/api/v1/setup/code", map[string]any{
		"setupToken": setupToken, "email": ownerEmail, "isInstanceAdmin": true,
	}), http.StatusBadRequest, "invalid_json")
}

func TestSecurityHeaders(t *testing.T) {
	ts := newServer(t)
	resp, err := http.Get(ts.url + "/api/v1/meta")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for k, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Cache-Control":          "no-store",
	} {
		if got := resp.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}
