package server_test

import (
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"fudislte/api/internal/mail/mailtest"
	"fudislte/api/internal/server"
)

type registryCall struct {
	method, path, auth string
	body               map[string]any
}

// fakeRegistry records what FUDISLTE sends to the project's registry.
func fakeRegistry(t *testing.T) (*httptest.Server, chan registryCall) {
	t.Helper()
	calls := make(chan registryCall, 10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := registryCall{method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization")}
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			_ = json.Unmarshal(b, &c.body)
		}
		calls <- c
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func nextCall(t *testing.T, calls chan registryCall) registryCall {
	t.Helper()
	select {
	case c := <-calls:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("the registry heard nothing")
		return registryCall{}
	}
}

func noCall(t *testing.T, calls chan registryCall) {
	t.Helper()
	select {
	case c := <-calls:
		t.Fatalf("unexpected registry call %+v", c)
	case <-time.After(300 * time.Millisecond):
	}
}

func withRegistry(url string) func(*server.Deps) {
	return func(d *server.Deps) { d.Config.RegistryURL = url }
}

type registrationState struct {
	Registration struct {
		Available        bool    `json:"available"`
		Enabled          bool    `json:"enabled"`
		OrganizationName string  `json:"organizationName"`
		ContactEmail     string  `json:"contactEmail"`
		UserCount        int     `json:"userCount"`
		LastSentAt       *string `json:"lastSentAt"`
	} `json:"registration"`
}

func TestRegistrationNeedsConsentAndSendsOnlyAgreedFields(t *testing.T) {
	registry, calls := fakeRegistry(t)
	ts := newServer(t, withRegistry(registry.URL))

	var meta struct {
		RegistrationAvailable bool `json:"registrationAvailable"`
	}
	ts.client().must(http.StatusOK, http.MethodGet, "/api/v1/meta", nil).decode(t, &meta)
	if !meta.RegistrationAvailable {
		t.Fatal("setup does not offer registration")
	}

	// The owner agrees during setup.
	owner := ts.client()
	owner.must(http.StatusAccepted, http.MethodPost, "/api/v1/setup/code", map[string]string{"setupToken": setupToken, "email": ownerEmail})
	code := mailtest.Code(t, ts.mail.Next(t, ownerEmail, "setup_code"))
	var out struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/setup", map[string]any{
		"setupToken": setupToken, "organizationName": "Acme Şirketi", "displayName": "Alex Owner",
		"email": ownerEmail, "code": code, "shareRegistration": true,
	}).decode(t, &out)

	report := nextCall(t, calls)
	if report.method != http.MethodPost || report.path != "/v1/instances" {
		t.Fatalf("report = %+v", report)
	}
	if keys := slices.Sorted(maps.Keys(report.body)); !slices.Equal(keys,
		[]string{"contactEmail", "instanceId", "organizationName", "secret", "userCount", "version"}) {
		t.Fatalf("report carries %v", keys)
	}
	if b := report.body; b["organizationName"] != "Acme Şirketi" || b["contactEmail"] != ownerEmail || b["userCount"] != 1.0 || b["version"] != "test" {
		t.Fatalf("report body = %v", b)
	}

	// Only instance administrators see or change it.
	dev, _ := ts.join(owner, out.Organization.ID, "dev@example.com", "developer")
	expectError(t, dev.do(http.MethodGet, "/api/v1/instance/registration", nil), http.StatusForbidden, "forbidden")
	expectError(t, dev.do(http.MethodPut, "/api/v1/instance/registration", map[string]any{"enabled": false}), http.StatusForbidden, "forbidden")

	var st registrationState
	deadline := time.Now().Add(5 * time.Second)
	for {
		owner.must(http.StatusOK, http.MethodGet, "/api/v1/instance/registration", nil).decode(t, &st)
		if st.Registration.LastSentAt != nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if r := st.Registration; !r.Available || !r.Enabled || r.LastSentAt == nil || r.UserCount != 2 || r.OrganizationName != "Acme Şirketi" {
		t.Fatalf("settings = %+v", r)
	}

	// The administrator can change what is shared; validation applies.
	expectError(t, owner.do(http.MethodPut, "/api/v1/instance/registration",
		map[string]any{"enabled": true, "organizationName": "Acme", "contactEmail": "not-an-email"}), http.StatusUnprocessableEntity, "validation_failed")
	owner.must(http.StatusOK, http.MethodPut, "/api/v1/instance/registration",
		map[string]any{"enabled": true, "organizationName": "Acme A.Ş.", "contactEmail": "it@acme.example"})
	update := nextCall(t, calls)
	if update.body["organizationName"] != "Acme A.Ş." || update.body["contactEmail"] != "it@acme.example" ||
		update.body["userCount"] != 2.0 || update.body["secret"] != report.body["secret"] || update.body["instanceId"] != report.body["instanceId"] {
		t.Fatalf("update = %v", update.body)
	}

	// Turning it off withdraws the record with the same secret.
	owner.must(http.StatusOK, http.MethodPut, "/api/v1/instance/registration", map[string]any{"enabled": false})
	withdraw := nextCall(t, calls)
	if withdraw.method != http.MethodDelete || withdraw.path != "/v1/instances/"+report.body["instanceId"].(string) ||
		withdraw.auth != "Bearer "+report.body["secret"].(string) {
		t.Fatalf("withdraw = %+v", withdraw)
	}
	noCall(t, calls)
}

func TestNoRegistrationWithoutConsent(t *testing.T) {
	registry, calls := fakeRegistry(t)
	ts := newServer(t, withRegistry(registry.URL))
	owner, _ := ts.setupInstance()
	noCall(t, calls)
	var st registrationState
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/instance/registration", nil).decode(t, &st)
	if st.Registration.Enabled || !st.Registration.Available {
		t.Fatalf("settings = %+v", st.Registration)
	}
}

func TestRegistrationUnavailableWithoutRegistry(t *testing.T) {
	ts := newServer(t)
	var meta struct {
		RegistrationAvailable bool `json:"registrationAvailable"`
	}
	ts.client().must(http.StatusOK, http.MethodGet, "/api/v1/meta", nil).decode(t, &meta)
	if meta.RegistrationAvailable {
		t.Fatal("registration offered without a registry")
	}
	owner, _ := ts.setupInstance()
	expectError(t, owner.do(http.MethodPut, "/api/v1/instance/registration",
		map[string]any{"enabled": true, "organizationName": "Acme", "contactEmail": ownerEmail}), http.StatusConflict, "registration_unavailable")
}
