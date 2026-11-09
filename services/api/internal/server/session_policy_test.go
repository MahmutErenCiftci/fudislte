package server_test

import (
	"net/http"
	"testing"
	"time"
)

type sessionPolicy struct {
	Policy struct {
		TTLHours int `json:"ttlHours"`
	} `json:"policy"`
	EndedSessions int `json:"endedSessions"`
}

type sessionList struct {
	Sessions []struct {
		ID        string    `json:"id"`
		CreatedAt time.Time `json:"createdAt"`
		ExpiresAt time.Time `json:"expiresAt"`
	} `json:"sessions"`
}

func (c *client) sessions() sessionList {
	c.t.Helper()
	var out sessionList
	c.must(http.StatusOK, http.MethodGet, "/api/v1/me/sessions", nil).decode(c.t, &out)
	return out
}

func lifetime(t *testing.T, l sessionList) time.Duration {
	t.Helper()
	if len(l.Sessions) != 1 {
		t.Fatalf("sessions = %+v", l)
	}
	return l.Sessions[0].ExpiresAt.Sub(l.Sessions[0].CreatedAt).Round(time.Minute)
}

func TestSessionLifetimeDefaultsTo48Hours(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()

	var p sessionPolicy
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/instance/session-policy", nil).decode(t, &p)
	if p.Policy.TTLHours != 48 {
		t.Fatalf("default lifetime = %d hours, want 48", p.Policy.TTLHours)
	}
	if got := lifetime(t, owner.sessions()); got != 48*time.Hour {
		t.Fatalf("owner session lasts %v, want 48h", got)
	}
	dev, _ := ts.join(owner, orgID, "dev@example.com", "developer")
	if got := lifetime(t, dev.sessions()); got != 48*time.Hour {
		t.Fatalf("invited member's session lasts %v, want 48h", got)
	}
}

func TestSessionLifetimeAppliesToEveryone(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")

	// Only instance administrators manage it — not even other workspace admins.
	expectError(t, dev.do(http.MethodGet, "/api/v1/instance/session-policy", nil), http.StatusForbidden, "forbidden")
	expectError(t, dev.do(http.MethodPut, "/api/v1/instance/session-policy", map[string]int{"ttlHours": 720}), http.StatusForbidden, "forbidden")
	for _, bad := range []int{0, -1, 2161} {
		expectError(t, owner.do(http.MethodPut, "/api/v1/instance/session-policy", map[string]int{"ttlHours": bad}),
			http.StatusUnprocessableEntity, "validation_failed")
	}

	// A longer lifetime extends existing sign-ins too.
	var p sessionPolicy
	owner.must(http.StatusOK, http.MethodPut, "/api/v1/instance/session-policy", map[string]int{"ttlHours": 72}).decode(t, &p)
	if p.Policy.TTLHours != 72 || p.EndedSessions != 0 {
		t.Fatalf("update = %+v", p)
	}
	if got := lifetime(t, dev.sessions()); got != 72*time.Hour {
		t.Fatalf("existing session lasts %v after the change, want 72h", got)
	}

	// A shorter one ends sign-ins older than it at once.
	if _, err := ts.db.Exec(t.Context(), `UPDATE sessions SET created_at = now() - interval '3 hours' WHERE user_id = $1`, devID); err != nil {
		t.Fatal(err)
	}
	owner.must(http.StatusOK, http.MethodPut, "/api/v1/instance/session-policy", map[string]int{"ttlHours": 2}).decode(t, &p)
	if p.EndedSessions != 1 {
		t.Fatalf("ended sessions = %d, want 1", p.EndedSessions)
	}
	expectError(t, dev.do(http.MethodGet, "/api/v1/me", nil), http.StatusUnauthorized, "unauthorized")
	owner.me()

	// New sign-ins get the new lifetime.
	again := ts.signIn("dev@example.com")
	if got := lifetime(t, again.sessions()); got != 2*time.Hour {
		t.Fatalf("new session lasts %v, want 2h", got)
	}

	var actions []string
	rows, err := ts.db.Query(t.Context(), `SELECT action FROM audit_events WHERE action = 'instance.session_policy_updated'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var a string
		_ = rows.Scan(&a)
		actions = append(actions, a)
	}
	rows.Close()
	if len(actions) != 2 {
		t.Fatalf("audit events = %v, want 2 policy updates", actions)
	}
}
