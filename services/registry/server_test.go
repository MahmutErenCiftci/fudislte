package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	password = "correct-horse-battery"
	instance = "0192f4a2-7c1e-7b3a-9d4e-1a2b3c4d5e6f"
	secret   = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t-0123"
)

type harness struct {
	t     *testing.T
	srv   *httptest.Server
	store *Store
	dir   string
	now   time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, dir: t.TempDir(), now: time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)}
	store, err := OpenStore(h.dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	h.store = store
	s := NewServer(store, password, false)
	s.now = func() time.Time { return h.now }
	h.srv = httptest.NewServer(s.Handler())
	t.Cleanup(h.srv.Close)
	return h
}

func (h *harness) do(method, path string, body any, header map[string]string) (int, string) {
	h.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rdr)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (h *harness) page(lang string) (int, string) {
	h.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, h.srv.URL+"/", nil)
	req.SetBasicAuth("admin", password)
	req.Header.Set("Accept-Language", lang)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func report(overrides map[string]any) map[string]any {
	r := map[string]any{
		"instanceId": instance, "secret": secret, "organizationName": "  Acme   A.Ş. ",
		"contactEmail": "IT@Acme.com.tr", "userCount": 42, "version": "0.1.0",
	}
	for k, v := range overrides {
		r[k] = v
	}
	return r
}

func TestRegisterRefreshAndWithdraw(t *testing.T) {
	h := newHarness(t)
	if status, _ := h.do(http.MethodPost, "/v1/instances", report(nil), nil); status != http.StatusNoContent {
		t.Fatalf("register: %d", status)
	}
	// Daily refresh with the same secret updates the counts; another secret cannot.
	h.now = h.now.Add(24 * time.Hour)
	if status, _ := h.do(http.MethodPost, "/v1/instances", report(map[string]any{"userCount": 57}), nil); status != http.StatusNoContent {
		t.Fatalf("refresh: %d", status)
	}
	if status, _ := h.do(http.MethodPost, "/v1/instances", report(map[string]any{"secret": strings.Repeat("x", 40), "organizationName": "Hijack"}), nil); status != http.StatusForbidden {
		t.Fatalf("overwrite with another secret: %d", status)
	}

	status, body := h.page("tr-TR,tr;q=0.9")
	if status != http.StatusOK || !strings.Contains(body, "Acme A.Ş.") || !strings.Contains(body, "it@acme.com.tr") ||
		!strings.Contains(body, ">57<") || strings.Contains(body, "Hijack") || !strings.Contains(body, "FUDISLTE kurulumları") ||
		!strings.Contains(body, "2026-11-07 12:00") || !strings.Contains(body, "2026-11-08 12:00") {
		t.Fatalf("page %d:\n%s", status, body)
	}
	if _, body := h.page("en-US"); !strings.Contains(body, "FUDISLTE installations") {
		t.Fatalf("English page:\n%s", body)
	}

	// The file on disk survives a restart (which flushes pending reports) and never
	// contains the secret itself.
	if err := h.store.Flush(); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(h.dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	if list := store.List(); len(list) != 1 || list[0].UserCount != 57 || list[0].SecretHash == secret {
		t.Fatalf("reloaded = %+v", list)
	}

	// Withdrawing needs the secret.
	if status, _ := h.do(http.MethodDelete, "/v1/instances/"+instance, nil, map[string]string{"Authorization": "Bearer " + strings.Repeat("y", 40)}); status != http.StatusForbidden {
		t.Fatalf("delete with another secret: %d", status)
	}
	if status, _ := h.do(http.MethodDelete, "/v1/instances/"+instance, nil, map[string]string{"Authorization": "Bearer " + secret}); status != http.StatusNoContent {
		t.Fatalf("delete: %d", status)
	}
	if _, body := h.page("tr"); strings.Contains(body, "Acme") {
		t.Fatalf("withdrawn instance still listed:\n%s", body)
	}
}

func TestReportValidation(t *testing.T) {
	h := newHarness(t)
	for name, o := range map[string]map[string]any{
		"id":      {"instanceId": "not-a-uuid"},
		"secret":  {"secret": "short"},
		"name":    {"organizationName": "   "},
		"long":    {"organizationName": strings.Repeat("a", 81)},
		"email":   {"contactEmail": "Someone <x@y.com>"},
		"users":   {"userCount": -1},
		"version": {"version": "<script>"},
	} {
		if status, _ := h.do(http.MethodPost, "/v1/instances", report(o), nil); status != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d, want 422", name, status)
		}
	}
	// Unknown fields are refused: a report carries only what the administrator agreed to.
	extra := report(map[string]any{"members": []string{"a@b.c"}})
	if status, _ := h.do(http.MethodPost, "/v1/instances", extra, nil); status != http.StatusBadRequest {
		t.Errorf("extra field: status %d, want 400", status)
	}
}

func TestRegistryIsBounded(t *testing.T) {
	h := newHarness(t) // holds at most 3
	ids := []string{
		"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002",
		"00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004",
	}
	for i, id := range ids {
		status, _ := h.do(http.MethodPost, "/v1/instances", report(map[string]any{"instanceId": id}), nil)
		want := http.StatusNoContent
		if i == 3 {
			want = http.StatusServiceUnavailable
		}
		if status != want {
			t.Fatalf("instance %d: status %d, want %d", i, status, want)
		}
	}
}

func TestListNeedsPassword(t *testing.T) {
	h := newHarness(t)
	h.do(http.MethodPost, "/v1/instances", report(map[string]any{"organizationName": "=HYPERLINK(1)"}), nil)
	if status, _ := h.do(http.MethodGet, "/", nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("no password: %d", status)
	}
	req, _ := http.NewRequest(http.MethodGet, h.srv.URL+"/", nil)
	req.SetBasicAuth("admin", "wrong-password-here")
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong password: %d", resp.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, h.srv.URL+"/instances.csv", nil)
	req.SetBasicAuth("", password)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.HasPrefix(string(b), "organization,contact_email,users,version,first_seen,last_seen\n") ||
		!strings.Contains(string(b), "'=HYPERLINK(1)") {
		t.Fatalf("csv:\n%s", b)
	}

	// Guessing is rate limited even when a guess would be right.
	for range 25 {
		req, _ := http.NewRequest(http.MethodGet, h.srv.URL+"/", nil)
		req.SetBasicAuth("admin", "guess-guess-guess")
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
	}
	if status, _ := h.page("tr"); status != http.StatusTooManyRequests {
		t.Fatalf("after many guesses: %d, want 429", status)
	}
}

func TestLimiter(t *testing.T) {
	l := newLimiter(time.Second, 2)
	now := time.Unix(0, 0)
	if !l.allow("a", now) || !l.allow("a", now) || l.allow("a", now) {
		t.Fatal("burst of 2 not enforced")
	}
	if !l.allow("b", now) {
		t.Fatal("keys share a bucket")
	}
	if !l.allow("a", now.Add(time.Second)) {
		t.Fatal("token not refilled")
	}
}
