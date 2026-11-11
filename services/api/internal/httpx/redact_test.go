package httpx

import "testing"

func TestRedactPathHidesInvitationTokens(t *testing.T) {
	for in, want := range map[string]string{
		"/api/v1/invitations/abc123":        "/api/v1/invitations/REDACTED",
		"/api/v1/invitations/abc123/code":   "/api/v1/invitations/REDACTED/code",
		"/api/v1/invitations/abc123/accept": "/api/v1/invitations/REDACTED/accept",
		"/api/v1/orgs/42/invitations":       "/api/v1/orgs/42/invitations",
		"/api/v1/auth/me":                   "/api/v1/auth/me",
	} {
		if got := redactPath(in); got != want {
			t.Errorf("redactPath(%q) = %q, want %q", in, got, want)
		}
	}
}
