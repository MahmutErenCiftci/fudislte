package server_test

import (
	"net/http"
	"testing"
)

func lang(tag string) http.Header { return http.Header{"Accept-Language": {tag}} }

func TestErrorsFollowAcceptLanguage(t *testing.T) {
	ts := newServer(t)
	owner, _ := ts.setupInstance()
	var e struct {
		Error struct {
			Message string            `json:"message"`
			Fields  map[string]string `json:"fields"`
		} `json:"error"`
	}
	owner.request(http.MethodPatch, "/api/v1/me", map[string]string{"displayName": " "}, lang("tr-TR,tr;q=0.9")).decode(t, &e)
	if e.Error.Message != "Bazı alanlar geçersiz." || e.Error.Fields["displayName"] != "Bir ad girin." {
		t.Fatalf("turkish error = %+v", e.Error)
	}
	owner.request(http.MethodPatch, "/api/v1/me", map[string]string{"displayName": " "}, lang("en-US")).decode(t, &e)
	if e.Error.Message != "Some fields are invalid." || e.Error.Fields["displayName"] != "Enter a name." {
		t.Fatalf("english error = %+v", e.Error)
	}

	var perms struct {
		Permissions []struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		} `json:"permissions"`
	}
	owner.request(http.MethodGet, "/api/v1/permissions", nil, lang("tr")).decode(t, &perms)
	if perms.Permissions[0].Key != "org.manage" || perms.Permissions[0].Name != "Çalışma alanını yönet" {
		t.Fatalf("permissions = %+v", perms.Permissions[0])
	}
}

func TestLanguagePreferenceIsSavedAndUsedForEmail(t *testing.T) {
	ts := newServer(t)
	owner, _ := ts.setupInstance()

	expectError(t, owner.do(http.MethodPatch, "/api/v1/me", map[string]string{"locale": "de"}), http.StatusUnprocessableEntity, "validation_failed")
	owner.must(http.StatusOK, http.MethodPatch, "/api/v1/me", map[string]string{"locale": "en"})
	if got := owner.me().User.Locale; got != "en" {
		t.Fatalf("locale = %q", got)
	}

	// The account's language wins over the language of the page that asked for the code.
	c := ts.client()
	c.request(http.MethodPost, "/api/v1/auth/code", map[string]string{"email": ownerEmail}, lang("tr"))
	if m := ts.mail.Next(t, ownerEmail, "login_code"); m.Subject != "Your FUDISLTE sign-in code" {
		t.Fatalf("subject = %q", m.Subject)
	}
	owner.must(http.StatusOK, http.MethodPatch, "/api/v1/me", map[string]string{"locale": "tr"})
	c.request(http.MethodPost, "/api/v1/auth/code", map[string]string{"email": ownerEmail}, lang("en"))
	if m := ts.mail.Next(t, ownerEmail, "login_code"); m.Subject != "FUDISLTE giriş kodunuz" {
		t.Fatalf("subject = %q", m.Subject)
	}
}

func TestLastActiveIsOnlyShownToManagers(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	dev, _ := ts.join(owner, orgID, "dev@example.com", "developer")
	type memberList struct {
		Members []struct {
			LastActiveAt *string `json:"lastActiveAt"`
		} `json:"members"`
	}
	var asOwner, asDev memberList
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/members", nil).decode(t, &asOwner)
	for _, m := range asOwner.Members {
		if m.LastActiveAt == nil {
			t.Fatalf("owner should see last activity: %+v", asOwner)
		}
	}
	dev.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/members", nil).decode(t, &asDev)
	for _, m := range asDev.Members {
		if m.LastActiveAt != nil {
			t.Fatal("developers must not see last activity")
		}
	}
}
