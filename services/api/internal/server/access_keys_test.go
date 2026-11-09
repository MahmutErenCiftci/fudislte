package server_test

import (
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

type createdKey struct {
	AccessKey struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		DisplayName string `json:"displayName"`
		Locale      string `json:"locale"`
		Role        struct {
			Key string `json:"key"`
		} `json:"role"`
		CreatedBy string    `json:"createdBy"`
		ExpiresAt time.Time `json:"expiresAt"`
	} `json:"accessKey"`
	Key string `json:"key"`
}

func (c *client) createKey(orgID string, body map[string]any) createdKey {
	c.t.Helper()
	var out createdKey
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/access-keys", body).decode(c.t, &out)
	return out
}

func (c *client) pendingKeys(orgID string) []string {
	c.t.Helper()
	var out struct {
		AccessKeys []struct {
			Email string `json:"email"`
		} `json:"accessKeys"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/access-keys", nil).decode(c.t, &out)
	var emails []string
	for _, k := range out.AccessKeys {
		emails = append(emails, k.Email)
	}
	return emails
}

var keyFormat = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$`)

func TestAccessKeySignsInWithPreparedAccount(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	roles := owner.roles(orgID)

	created := owner.createKey(orgID, map[string]any{
		"email": " Ayse.Yilmaz@Example.com ", "displayName": "Ayşe Yılmaz", "roleId": roles["developer"].ID, "locale": "en",
	})
	k := created.AccessKey
	if !keyFormat.MatchString(created.Key) || k.Email != "ayse.yilmaz@example.com" || k.Role.Key != "developer" ||
		k.Locale != "en" || k.CreatedBy != "Alex Owner" {
		t.Fatalf("created = %+v", created)
	}
	if d := time.Until(k.ExpiresAt); d < 6*24*time.Hour || d > 7*24*time.Hour {
		t.Fatalf("key expires in %v, want 7 days", d)
	}
	if got := owner.pendingKeys(orgID); !slices.Equal(got, []string{"ayse.yilmaz@example.com"}) {
		t.Fatalf("pending keys = %v", got)
	}

	// Typed loosely — lower case, no dashes, spaces — it still works and opens the app.
	person := ts.client()
	loose := strings.ToLower(strings.ReplaceAll(created.Key, "-", " "))
	person.must(http.StatusOK, http.MethodPost, "/api/v1/auth/access-key", map[string]string{"key": loose})
	m := person.me()
	if m.User.Email != "ayse.yilmaz@example.com" || m.User.DisplayName != "Ayşe Yılmaz" || m.User.Locale != "en" || m.User.IsInstanceAdmin {
		t.Fatalf("user = %+v", m.User)
	}
	if len(m.Workspaces) != 1 || m.Workspaces[0].Organization.ID != orgID || m.Workspaces[0].Role.Key != "developer" {
		t.Fatalf("workspaces = %+v", m.Workspaces)
	}
	if got := lifetime(t, person.sessions()); got != 48*time.Hour {
		t.Fatalf("session lasts %v, want 48h", got)
	}
	// No email was needed.
	ts.mail.None(t, "ayse.yilmaz@example.com", "login_code", 100*time.Millisecond)

	// Single use; afterwards the person signs in with email codes.
	expectError(t, ts.client().do(http.MethodPost, "/api/v1/auth/access-key", map[string]string{"key": created.Key}),
		http.StatusUnauthorized, "invalid_access_key")
	if got := owner.pendingKeys(orgID); len(got) != 0 {
		t.Fatalf("pending keys after use = %v", got)
	}
	ts.signIn("ayse.yilmaz@example.com")

	var events struct {
		Events []struct {
			Action string `json:"action"`
		} `json:"events"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/audit-events", nil).decode(t, &events)
	var actions []string
	for _, e := range events.Events {
		actions = append(actions, e.Action)
	}
	for _, want := range []string{"access_key.created", "access_key.used"} {
		if !slices.Contains(actions, want) {
			t.Errorf("audit log %v is missing %s", actions, want)
		}
	}
}

func TestAccessKeyRules(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	roles := owner.roles(orgID)
	keys := "/api/v1/orgs/" + orgID + "/access-keys"
	redeem := func(key string) response {
		return ts.client().do(http.MethodPost, "/api/v1/auth/access-key", map[string]string{"key": key})
	}

	// Validation.
	for _, body := range []map[string]any{
		{"email": "not-an-email", "displayName": "X", "roleId": roles["employee"].ID},
		{"email": "a@example.com", "displayName": " ", "roleId": roles["employee"].ID},
		{"email": "a@example.com", "displayName": "A", "roleId": roles["employee"].ID, "locale": "de"},
		{"email": "a@example.com", "displayName": "A", "roleId": roles["employee"].ID, "validDays": 91},
		{"email": "a@example.com", "displayName": "A", "roleId": "00000000-0000-0000-0000-000000000000"},
		// A key never signs in to an existing account.
		{"email": ownerEmail, "displayName": "Owner", "roleId": roles["employee"].ID},
	} {
		expectError(t, owner.do(http.MethodPost, keys, body), http.StatusUnprocessableEntity, "validation_failed")
	}
	for _, bad := range []string{"", "abc", strings.Repeat("A", 21), "UUUUU-UUUUU-UUUUU-UUUUU", "00000-00000-00000-00000"} {
		expectError(t, redeem(bad), http.StatusUnauthorized, "invalid_access_key")
	}

	// Revoked and superseded keys stop working.
	revoked := owner.createKey(orgID, map[string]any{"email": "gone@example.com", "displayName": "Gone", "roleId": roles["employee"].ID})
	owner.must(http.StatusNoContent, http.MethodDelete, keys+"/"+revoked.AccessKey.ID, nil)
	expectError(t, redeem(revoked.Key), http.StatusUnauthorized, "invalid_access_key")
	first := owner.createKey(orgID, map[string]any{"email": "twice@example.com", "displayName": "Twice", "roleId": roles["employee"].ID})
	second := owner.createKey(orgID, map[string]any{"email": "twice@example.com", "displayName": "Twice", "roleId": roles["guest"].ID})
	expectError(t, redeem(first.Key), http.StatusUnauthorized, "invalid_access_key")

	// An account created in the meantime (here by invitation) is not taken over.
	ts.join(owner, orgID, "twice@example.com", "employee")
	expectError(t, redeem(second.Key), http.StatusConflict, "account_exists")

	// Expired keys stop working.
	late := owner.createKey(orgID, map[string]any{"email": "late@example.com", "displayName": "Late", "roleId": roles["employee"].ID, "validDays": 1})
	if _, err := ts.db.Exec(t.Context(), `UPDATE access_keys SET expires_at = now() - interval '1 second' WHERE id = $1`, late.AccessKey.ID); err != nil {
		t.Fatal(err)
	}
	expectError(t, redeem(late.Key), http.StatusUnauthorized, "invalid_access_key")

	// People who may invite, but do not run the server, only create keys for addresses on
	// the workspace's verified domains, and only with roles below their own.
	lead, _ := ts.join(owner, orgID, "lead@example.com", "team-leader")
	expectError(t, lead.do(http.MethodPost, keys, map[string]any{"email": "new@firma.test", "displayName": "New", "roleId": roles["employee"].ID}),
		http.StatusUnprocessableEntity, "validation_failed")
	domains := "/api/v1/orgs/" + orgID + "/domains"
	var listed struct {
		Domains []struct {
			Record string `json:"record"`
		} `json:"domains"`
	}
	owner.must(http.StatusCreated, http.MethodPost, domains, map[string]string{"domain": "firma.test", "roleId": roles["employee"].ID})
	owner.must(http.StatusOK, http.MethodGet, domains, nil).decode(t, &listed)
	ts.dns.set("firma.test", listed.Domains[0].Record)
	owner.must(http.StatusOK, http.MethodPost, domains+"/firma.test/verify", nil)
	expectError(t, lead.do(http.MethodPost, keys, map[string]any{"email": "new@firma.test", "displayName": "New", "roleId": roles["administrator"].ID}),
		http.StatusForbidden, "forbidden")
	lead.createKey(orgID, map[string]any{"email": "new@firma.test", "displayName": "New", "roleId": roles["employee"].ID})

	// Members without the invite permission see nothing.
	dev, _ := ts.join(owner, orgID, "dev@example.com", "developer")
	expectError(t, dev.do(http.MethodGet, keys, nil), http.StatusForbidden, "forbidden")

	// Pending keys block deleting their role, like invitations.
	var custom struct {
		Role struct {
			ID string `json:"id"`
		} `json:"role"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/roles",
		map[string]any{"name": "Contractor", "position": 10, "permissions": []string{}}).decode(t, &custom)
	owner.createKey(orgID, map[string]any{"email": "c@example.com", "displayName": "C", "roleId": custom.Role.ID})
	expectError(t, owner.do(http.MethodDelete, "/api/v1/orgs/"+orgID+"/roles/"+custom.Role.ID, nil), http.StatusConflict, "role_in_use")
}
