package server_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

type room struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	Access             string     `json:"access"`
	HasPassword        bool       `json:"hasPassword"`
	AdmissionMinutes   int        `json:"admissionMinutes"`
	MemberCount        int        `json:"memberCount"`
	Admitted           bool       `json:"admitted"`
	AdmissionExpiresAt *time.Time `json:"admissionExpiresAt"`
	CanEnter           bool       `json:"canEnter"`
	NeedsPassword      bool       `json:"needsPassword"`
	CanManage          bool       `json:"canManage"`
}

func (c *client) createRoom(orgID string, body map[string]any) room {
	c.t.Helper()
	var out struct {
		Room room `json:"room"`
	}
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/rooms", body).decode(c.t, &out)
	return out.Room
}

func (c *client) rooms(orgID, query string) []room {
	c.t.Helper()
	var out struct {
		Rooms []room `json:"rooms"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/rooms"+query, nil).decode(c.t, &out)
	return out.Rooms
}

func (c *client) enterRoom(orgID, roomID, password string) response {
	c.t.Helper()
	return c.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/rooms/"+roomID+"/enter", map[string]string{"password": password})
}

func (c *client) entered(orgID, roomID, password string) room {
	c.t.Helper()
	var out struct {
		Room room `json:"room"`
	}
	r := c.enterRoom(orgID, roomID, password)
	if r.status != http.StatusOK {
		c.t.Fatalf("enter room: %d %s", r.status, r.body)
	}
	r.decode(c.t, &out)
	return out.Room
}

func roomEvent(roomID string) func(json.RawMessage) bool {
	return func(data json.RawMessage) bool { return strings.Contains(string(data), roomID) }
}

func TestSecureRooms(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	lead, _ := ts.join(owner, orgID, "lead@example.com", "team-leader")
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	other, _ := ts.join(owner, orgID, "other@example.com", "developer")
	guest, _ := ts.join(owner, orgID, "guest@example.com", "guest")
	sec, _ := ts.join(owner, orgID, "sec@example.com", "security-administrator")
	base := "/api/v1/orgs/" + orgID
	const secret = "Çok gizli 2026"

	// Validation.
	expectError(t, lead.do(http.MethodPost, base+"/rooms", map[string]any{"name": "Kısa", "access": "protected", "password": "kısa"}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, lead.do(http.MethodPost, base+"/rooms", map[string]any{"name": "Açık", "access": "open", "password": secret}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, lead.do(http.MethodPost, base+"/rooms", map[string]any{"name": "X", "access": "secret"}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, guest.do(http.MethodPost, base+"/rooms", map[string]any{"name": "Misafir", "access": "open"}),
		http.StatusForbidden, "forbidden")

	vault := lead.createRoom(orgID, map[string]any{"name": "Güvenlik  Odası", "topic": "Olay müdahalesi", "access": "protected", "password": secret})
	if vault.Name != "Güvenlik Odası" || !vault.HasPassword || vault.NeedsPassword || !vault.Admitted || vault.AdmissionMinutes != 720 {
		t.Fatalf("created = %+v", vault)
	}
	expectError(t, other.do(http.MethodPost, base+"/rooms", map[string]any{"name": "güvenlik odası", "access": "open"}),
		http.StatusConflict, "room_name_taken")
	if find(lead.channels(orgID), "Güvenlik Odası") != nil {
		t.Fatal("rooms must stay out of the channel list")
	}
	lead.post(orgID, vault.ID, "Gizli plan burada.")

	// Before entering: the room is listed, its contents are not readable.
	listed := emp.rooms(orgID, "")
	if len(listed) != 1 || !listed[0].NeedsPassword || listed[0].Admitted || !listed[0].CanEnter || listed[0].CanManage {
		t.Fatalf("employee rooms = %+v", listed)
	}
	expectError(t, emp.do(http.MethodGet, base+"/channels/"+vault.ID+"/messages", nil), http.StatusNotFound, "not_found")

	// A wrong password is refused and audited.
	expectError(t, emp.enterRoom(orgID, vault.ID, "yanlış şifre"), http.StatusForbidden, "wrong_password")
	in := emp.entered(orgID, vault.ID, secret)
	if !in.Admitted || in.AdmissionExpiresAt == nil || time.Until(*in.AdmissionExpiresAt) < 11*time.Hour {
		t.Fatalf("admission = %+v", in)
	}
	if got := emp.history(orgID, vault.ID, ""); len(got.Messages) != 1 {
		t.Fatalf("history after entering = %+v", got)
	}
	emp.post(orgID, vault.ID, "Gördüm, teşekkürler.")

	// Exit criterion: the right password never bypasses authorization.
	expectError(t, guest.enterRoom(orgID, vault.ID, secret), http.StatusNotFound, "not_found")
	if len(guest.rooms(orgID, "")) != 0 {
		t.Fatal("guests must not see password-protected rooms")
	}
	restricted := lead.createRoom(orgID, map[string]any{
		"name": "Yönetim", "access": "restricted", "password": secret, "memberIds": []string{empID},
	})
	expectError(t, other.enterRoom(orgID, restricted.ID, secret), http.StatusNotFound, "not_found")
	expectError(t, sec.enterRoom(orgID, restricted.ID, secret), http.StatusForbidden, "room_not_allowed")
	expectError(t, owner.enterRoom(orgID, restricted.ID, secret), http.StatusForbidden, "room_not_allowed")
	if r := emp.entered(orgID, restricted.ID, secret); !r.Admitted {
		t.Fatalf("listed person could not enter: %+v", r)
	}

	// Search and notifications follow admission.
	search := func(c *client) int {
		var out struct {
			Results []json.RawMessage `json:"results"`
		}
		c.must(http.StatusOK, http.MethodGet, base+"/search?q="+url.QueryEscape("gizli plan"), nil).decode(t, &out)
		return len(out.Results)
	}
	if search(emp) != 1 || search(owner) != 0 {
		t.Fatal("search must follow room admission")
	}

	// Room managers (rooms.manage) see settings, not contents.
	all := sec.rooms(orgID, "?all=true")
	if len(all) != 2 || !all[0].CanManage {
		t.Fatalf("manager list = %+v", all)
	}
	expectError(t, emp.do(http.MethodGet, base+"/rooms?all=true", nil), http.StatusForbidden, "forbidden")
	expectError(t, sec.do(http.MethodGet, base+"/channels/"+vault.ID+"/messages", nil), http.StatusNotFound, "not_found")
	expectError(t, emp.do(http.MethodPost, base+"/channels/"+vault.ID+"/members", map[string]any{"userIds": []string{empID}}),
		http.StatusConflict, "room_managed")

	// Rotating the password ends admissions at once: events, history and files.
	file := emp.uploaded(orgID, vault.ID, "rapor.txt", []byte("gizli rapor"))
	emp.postRich(orgID, vault.ID, map[string]any{"attachmentIds": []string{file.ID}})
	empEvents := emp.events()
	lead.must(http.StatusOK, http.MethodPut, base+"/rooms/"+vault.ID+"/security",
		map[string]any{"access": "protected", "password": "Yeni şifre 2027"})
	empEvents.waitFor("channel.left", roomEvent(vault.ID))
	expectError(t, emp.do(http.MethodGet, base+"/channels/"+vault.ID+"/messages", nil), http.StatusNotFound, "not_found")
	if r := emp.download(orgID, file.ID, ""); r.StatusCode != http.StatusNotFound {
		t.Fatalf("file after rotation: %d", r.StatusCode)
	}
	lead.post(orgID, vault.ID, "Şifre değişti.")
	empEvents.quiet()
	expectError(t, emp.enterRoom(orgID, vault.ID, secret), http.StatusForbidden, "wrong_password")
	emp.entered(orgID, vault.ID, "Yeni şifre 2027")

	// An expired admission is over even before the cleanup job runs.
	if _, err := ts.db.Exec(t.Context(), `UPDATE channel_members SET expires_at = now() - interval '1 second' WHERE channel_id = $1 AND user_id = $2`,
		vault.ID, empID); err != nil {
		t.Fatal(err)
	}
	expectError(t, emp.do(http.MethodGet, base+"/channels/"+vault.ID+"/messages", nil), http.StatusNotFound, "not_found")
	if search(emp) != 0 {
		t.Fatal("search after expiry")
	}
	if r := emp.rooms(orgID, ""); r[0].Name != "Güvenlik Odası" || r[0].Admitted {
		t.Fatalf("expired admission still listed: %+v", r)
	}
	emp.entered(orgID, vault.ID, "Yeni şifre 2027")

	// Managers end one admission; the access list keeps people out of restricted rooms.
	empEvents = emp.events()
	sec.must(http.StatusNoContent, http.MethodDelete, base+"/rooms/"+vault.ID+"/members/"+empID, nil)
	empEvents.waitFor("channel.left", roomEvent(vault.ID))
	lead.must(http.StatusOK, http.MethodPut, base+"/rooms/"+restricted.ID+"/access", map[string]any{"userIds": []string{}})
	empEvents.waitFor("channel.left", roomEvent(restricted.ID))
	expectError(t, emp.enterRoom(orgID, restricted.ID, secret), http.StatusNotFound, "not_found")
	expectError(t, lead.do(http.MethodPut, base+"/rooms/"+vault.ID+"/access", map[string]any{"userIds": []string{}}),
		http.StatusConflict, "room_not_restricted")
	expectError(t, emp.do(http.MethodPut, base+"/rooms/"+vault.ID+"/security", map[string]any{"access": "open"}),
		http.StatusForbidden, "forbidden")

	// Password guesses are limited per person and room.
	for range 5 {
		expectError(t, other.enterRoom(orgID, vault.ID, "tahmin 1234"), http.StatusForbidden, "wrong_password")
	}
	expectError(t, other.enterRoom(orgID, vault.ID, "Yeni şifre 2027"), http.StatusTooManyRequests, "rate_limited")

	// Every security event is in the audit log.
	var audit struct {
		Events []struct {
			Action string `json:"action"`
		} `json:"events"`
	}
	owner.must(http.StatusOK, http.MethodGet, base+"/audit-events", nil).decode(t, &audit)
	seen := map[string]bool{}
	for _, e := range audit.Events {
		seen[e.Action] = true
	}
	for _, action := range []string{"room.created", "room.password_failed", "room.entered", "room.security_changed", "room.admission_ended", "room.access_changed"} {
		if !seen[action] {
			t.Errorf("audit log lacks %s", action)
		}
	}

	// Deleting a room removes it with its files.
	lead.must(http.StatusNoContent, http.MethodDelete, base+"/rooms/"+vault.ID, nil)
	expectError(t, lead.do(http.MethodGet, base+"/rooms/"+vault.ID, nil), http.StatusNotFound, "not_found")
	if r := lead.download(orgID, file.ID, ""); r.StatusCode != http.StatusNotFound {
		t.Fatalf("file after delete: %d", r.StatusCode)
	}
}

func TestOpenRoomsAndSecurityChanges(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	base := "/api/v1/orgs/" + orgID

	lounge := owner.createRoom(orgID, map[string]any{"name": "Mutfak", "access": "open", "admissionMinutes": 60})
	if r := emp.entered(orgID, lounge.ID, ""); !r.Admitted || r.AdmissionExpiresAt != nil {
		t.Fatalf("open room admission = %+v", r)
	}
	// Closing an open room with a password sends everyone but its creator out.
	owner.must(http.StatusOK, http.MethodPut, base+"/rooms/"+lounge.ID+"/security", map[string]any{"access": "protected", "password": "mutfak şifresi"})
	if r := emp.rooms(orgID, ""); len(r) != 1 || r[0].Admitted || !r[0].NeedsPassword {
		t.Fatalf("after protecting = %+v", r)
	}
	expectError(t, owner.do(http.MethodPut, base+"/rooms/"+lounge.ID+"/security", map[string]any{"access": "protected", "removePassword": true}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPatch, base+"/rooms/"+lounge.ID, map[string]any{"admissionMinutes": 5}),
		http.StatusUnprocessableEntity, "validation_failed")

	// A shorter admission also shortens the ones already granted.
	emp.entered(orgID, lounge.ID, "mutfak şifresi")
	owner.must(http.StatusOK, http.MethodPatch, base+"/rooms/"+lounge.ID, map[string]any{"admissionMinutes": 15})
	if r := emp.rooms(orgID, ""); r[0].AdmissionExpiresAt == nil || time.Until(*r[0].AdmissionExpiresAt) > 16*time.Minute {
		t.Fatalf("admission not shortened: %+v", r[0])
	}
	// Leaving is always possible.
	emp.must(http.StatusNoContent, http.MethodPost, base+"/rooms/"+lounge.ID+"/leave", nil)
	if r := emp.rooms(orgID, ""); r[0].Admitted {
		t.Fatal("still admitted after leaving")
	}
}
