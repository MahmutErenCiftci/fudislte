package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"fudislte/api/internal/mail"
	"fudislte/api/internal/server"
)

type meetingPerson struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type meeting struct {
	ID              string          `json:"id"`
	Title           string          `json:"title"`
	Agenda          string          `json:"agenda"`
	StartsAt        time.Time       `json:"startsAt"`
	DurationMinutes int             `json:"durationMinutes"`
	EndsAt          time.Time       `json:"endsAt"`
	TimeZone        string          `json:"timeZone"`
	Organizer       *meetingPerson  `json:"organizer"`
	Invitees        []meetingPerson `json:"invitees"`
	CanceledAt      *time.Time      `json:"canceledAt"`
	OpensAt         time.Time       `json:"opensAt"`
	ClosesAt        time.Time       `json:"closesAt"`
	IsOrganizer     bool            `json:"isOrganizer"`
}

func (c *client) createMeeting(orgID string, body map[string]any) meeting {
	c.t.Helper()
	var out struct {
		Meeting meeting `json:"meeting"`
	}
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/meetings", body).decode(c.t, &out)
	return out.Meeting
}

func (c *client) meetings(orgID, query string) []meeting {
	c.t.Helper()
	var out struct {
		Meetings []meeting `json:"meetings"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/meetings"+query, nil).decode(c.t, &out)
	return out.Meetings
}

func (c *client) patchMeeting(orgID, id string, body map[string]any) meeting {
	c.t.Helper()
	var out struct {
		Meeting meeting `json:"meeting"`
	}
	c.must(http.StatusOK, http.MethodPatch, "/api/v1/orgs/"+orgID+"/meetings/"+id, body).decode(c.t, &out)
	return out.Meeting
}

// calendar returns an email's calendar file, unfolded (RFC 5545 3.1).
func calendar(t *testing.T, m mail.Message) string {
	t.Helper()
	if len(m.Attachments) != 1 || !strings.HasPrefix(m.Attachments[0].ContentType, "text/calendar") {
		t.Fatalf("%s email to %s has no calendar file: %+v", m.Kind, m.To, m.Attachments)
	}
	return strings.ReplaceAll(string(m.Attachments[0].Data), "\r\n ", "")
}

func expectCalendar(t *testing.T, ics string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(ics, w+"\r\n") {
			t.Errorf("calendar file lacks %q:\n%s", w, ics)
		}
	}
}

func icsTime(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

func TestMeetings(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	lead, leadID := ts.join(owner, orgID, "lead@example.com", "team-leader")
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	other, otherID := ts.join(owner, orgID, "other@example.com", "developer")
	guest, guestID := ts.join(owner, orgID, "guest@example.com", "guest")
	base := "/api/v1/orgs/" + orgID + "/meetings"
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	// The employee reads email in English; the others keep Turkish.
	emp.must(http.StatusOK, http.MethodPatch, "/api/v1/me", map[string]string{"locale": "en"})

	// Validation.
	invalid := func(r response) map[string]string {
		t.Helper()
		expectError(t, r, http.StatusUnprocessableEntity, "validation_failed")
		var e apiError
		r.decode(t, &e)
		return e.Error.Fields
	}
	fields := invalid(lead.do(http.MethodPost, base, map[string]any{
		"title": "  ", "agenda": strings.Repeat("a", 2001), "startsAt": time.Now().Add(-time.Hour),
		"durationMinutes": 10, "timeZone": "Mars/Olympus",
	}))
	for _, field := range []string{"title", "agenda", "startsAt", "durationMinutes", "timeZone"} {
		if fields[field] == "" {
			t.Errorf("no error for %s: %v", field, fields)
		}
	}
	if f := invalid(lead.do(http.MethodPost, base, map[string]any{"title": "Uzak", "startsAt": time.Now().Add(400 * 24 * time.Hour)})); f["startsAt"] == "" {
		t.Fatalf("a start more than a year ahead: %v", f)
	}
	if f := invalid(lead.do(http.MethodPost, base, map[string]any{"title": "Yabancı", "startsAt": start, "inviteeIds": []string{uuid.NewString()}})); f["inviteeIds"] == "" {
		t.Fatalf("a stranger was invited: %v", f)
	}
	expectError(t, guest.do(http.MethodPost, base, map[string]any{"title": "Misafir", "startsAt": start}), http.StatusForbidden, "forbidden")

	mt := lead.createMeeting(orgID, map[string]any{
		"title": "  Sprint   Planlama ", "agenda": "Hedefler\r\nRiskler", "startsAt": start, "durationMinutes": 45,
		"timeZone": "Europe/Istanbul", "inviteeIds": []string{empID, guestID, leadID, empID},
	})
	if mt.Title != "Sprint Planlama" || mt.Agenda != "Hedefler\nRiskler" || !mt.IsOrganizer || mt.Organizer == nil || mt.Organizer.ID != leadID ||
		len(mt.Invitees) != 2 || mt.Invitees[0].ID != empID || mt.Invitees[1].ID != guestID || mt.TimeZone != "Europe/Istanbul" ||
		!mt.StartsAt.Equal(start) || !mt.EndsAt.Equal(start.Add(45*time.Minute)) ||
		!mt.OpensAt.Equal(start.Add(-15*time.Minute)) || !mt.ClosesAt.Equal(start.Add(45*time.Minute+2*time.Hour)) {
		t.Fatalf("created = %+v", mt)
	}

	// Invitations go to the invitees in their own language, with a calendar request.
	inv := ts.mail.Next(t, "emp@example.com", "meeting_invitation")
	if inv.Subject != "Invitation: Sprint Planlama" || !strings.Contains(inv.Body, publicURL+"/w/acme-sirketi/m/"+mt.ID) {
		t.Fatalf("invitation = %q\n%s", inv.Subject, inv.Body)
	}
	expectCalendar(t, calendar(t, inv), "METHOD:REQUEST", "UID:"+mt.ID+"@fudislte.test", "SEQUENCE:0",
		"DTSTART:"+icsTime(start), "DTEND:"+icsTime(start.Add(45*time.Minute)))
	if g := ts.mail.Next(t, "guest@example.com", "meeting_invitation"); g.Subject != "Toplantı daveti: Sprint Planlama" {
		t.Fatalf("guest invitation subject = %q", g.Subject)
	}
	ts.mail.None(t, "lead@example.com", "meeting_invitation", 100*time.Millisecond)

	// Only the organizer and invitees see the meeting — not other members, not the owner.
	if l := emp.meetings(orgID, "?range=upcoming"); len(l) != 1 || l[0].ID != mt.ID || l[0].IsOrganizer {
		t.Fatalf("employee meetings = %+v", l)
	}
	if l := emp.meetings(orgID, "?range=past"); len(l) != 0 {
		t.Fatalf("past meetings = %+v", l)
	}
	if l := other.meetings(orgID, ""); len(l) != 0 {
		t.Fatalf("a meeting leaked to someone not invited: %+v", l)
	}
	expectError(t, other.do(http.MethodGet, base+"/"+mt.ID, nil), http.StatusNotFound, "not_found")
	expectError(t, owner.do(http.MethodGet, base+"/"+mt.ID, nil), http.StatusNotFound, "not_found")
	guest.must(http.StatusOK, http.MethodGet, base+"/"+mt.ID, nil)
	expectError(t, emp.do(http.MethodGet, base+"?range=later", nil), http.StatusUnprocessableEntity, "validation_failed")

	// Another workspace never reaches it, even for someone who belongs to both.
	var beta struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs", map[string]string{"name": "Beta Ltd"}).decode(t, &beta)
	betaBase := "/api/v1/orgs/" + beta.Organization.ID + "/meetings"
	expectError(t, owner.do(http.MethodGet, betaBase+"/"+mt.ID, nil), http.StatusNotFound, "not_found")
	expectError(t, owner.do(http.MethodPatch, betaBase+"/"+mt.ID, map[string]any{"title": "X"}), http.StatusNotFound, "not_found")
	expectError(t, emp.do(http.MethodGet, betaBase, nil), http.StatusNotFound, "not_found")
	if l := owner.meetings(beta.Organization.ID, ""); len(l) != 0 {
		t.Fatalf("beta meetings = %+v", l)
	}
	if f := invalid(owner.do(http.MethodPost, betaBase, map[string]any{"title": "Çapraz", "startsAt": start, "inviteeIds": []string{empID}})); f["inviteeIds"] == "" {
		t.Fatalf("someone from another workspace was invited: %v", f)
	}

	// Only the organizer changes or cancels it.
	expectError(t, emp.do(http.MethodPatch, base+"/"+mt.ID, map[string]any{"title": "X"}), http.StatusForbidden, "forbidden")
	expectError(t, emp.do(http.MethodDelete, base+"/"+mt.ID, nil), http.StatusForbidden, "forbidden")
	expectError(t, other.do(http.MethodPatch, base+"/"+mt.ID, map[string]any{"title": "X"}), http.StatusNotFound, "not_found")

	// A new title sends no email; a new invitee gets the invitation, and someone taken
	// off the list a cancellation for their calendar. Everyone concerned is told.
	empEvents, guestEvents := emp.events(), guest.events()
	updated := lead.patchMeeting(orgID, mt.ID, map[string]any{"title": "Sprint Planlama 12", "inviteeIds": []string{empID, otherID}})
	if updated.Title != "Sprint Planlama 12" || len(updated.Invitees) != 2 || updated.Invitees[0].ID != otherID || updated.Invitees[1].ID != empID {
		t.Fatalf("updated = %+v", updated)
	}
	empEvents.waitFor("meeting.updated", roomEvent(mt.ID))
	guestEvents.waitFor("meeting.updated", roomEvent(mt.ID))
	ts.mail.Next(t, "other@example.com", "meeting_invitation")
	expectCalendar(t, calendar(t, ts.mail.Next(t, "guest@example.com", "meeting_removed")), "METHOD:CANCEL", "UID:"+mt.ID+"@fudislte.test")
	ts.mail.None(t, "emp@example.com", "meeting_updated", 100*time.Millisecond)
	expectError(t, guest.do(http.MethodGet, base+"/"+mt.ID, nil), http.StatusNotFound, "not_found")

	// A new time bumps the calendar sequence and reaches everyone invited.
	later := start.Add(24 * time.Hour)
	lead.patchMeeting(orgID, mt.ID, map[string]any{"startsAt": later, "durationMinutes": 60})
	up := ts.mail.Next(t, "emp@example.com", "meeting_updated")
	if up.Subject != "Updated: Sprint Planlama 12" {
		t.Fatalf("update subject = %q", up.Subject)
	}
	expectCalendar(t, calendar(t, up), "METHOD:REQUEST", "SEQUENCE:1", "DTSTART:"+icsTime(later), "DTEND:"+icsTime(later.Add(time.Hour)))
	ts.mail.Next(t, "other@example.com", "meeting_updated")

	// Canceling keeps the meeting listed; it cannot change any more.
	empEvents = emp.events()
	lead.must(http.StatusOK, http.MethodDelete, base+"/"+mt.ID, nil)
	empEvents.waitFor("meeting.updated", roomEvent(mt.ID))
	expectCalendar(t, calendar(t, ts.mail.Next(t, "emp@example.com", "meeting_canceled")), "METHOD:CANCEL", "STATUS:CANCELLED", "SEQUENCE:2")
	if l := emp.meetings(orgID, ""); len(l) != 1 || l[0].CanceledAt == nil {
		t.Fatalf("canceled meeting = %+v", l)
	}
	expectError(t, lead.do(http.MethodPatch, base+"/"+mt.ID, map[string]any{"title": "Yeniden"}), http.StatusConflict, "meeting_canceled")
	expectError(t, lead.do(http.MethodDelete, base+"/"+mt.ID, nil), http.StatusConflict, "meeting_canceled")

	var audit struct {
		Events []struct {
			Action string `json:"action"`
		} `json:"events"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/audit-events", nil).decode(t, &audit)
	seen := map[string]bool{}
	for _, ev := range audit.Events {
		seen[ev.Action] = true
	}
	for _, action := range []string{"meeting.created", "meeting.updated", "meeting.canceled"} {
		if !seen[action] {
			t.Errorf("audit log lacks %s", action)
		}
	}
}

func TestMeetingVoice(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	lead, _ := ts.join(owner, orgID, "lead@example.com", "team-leader")
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	other, otherID := ts.join(owner, orgID, "other@example.com", "developer")
	base := "/api/v1/orgs/" + orgID + "/meetings/"

	// Too early: the meeting opens 15 minutes before it starts.
	soon := lead.createMeeting(orgID, map[string]any{"title": "Sonra", "startsAt": time.Now().Add(time.Hour), "inviteeIds": []string{empID}})
	expectError(t, emp.do(http.MethodPost, base+soon.ID+"/voice", nil), http.StatusConflict, "meeting_not_started")
	expectError(t, other.do(http.MethodPost, base+soon.ID+"/voice", nil), http.StatusNotFound, "not_found")

	// Inside the window, a token for the meeting's own LiveKit room until the window closes.
	live := lead.createMeeting(orgID, map[string]any{"title": "Şimdi", "startsAt": time.Now(), "durationMinutes": 30, "inviteeIds": []string{empID}})
	lkRoom := "fudislte-meeting-" + live.ID
	var ticket struct {
		Voice struct {
			URL       string    `json:"url"`
			Token     string    `json:"token"`
			ExpiresAt time.Time `json:"expiresAt"`
		} `json:"voice"`
	}
	emp.must(http.StatusOK, http.MethodPost, base+live.ID+"/voice", nil).decode(t, &ticket)
	claims := liveKitClaims(t, ticket.Voice.Token)
	video := claims["video"].(map[string]any)
	if video["room"] != lkRoom || claims["sub"] != empID || int64(claims["exp"].(float64)) != live.ClosesAt.Unix() ||
		!ticket.Voice.ExpiresAt.Equal(live.ClosesAt) || !live.ClosesAt.Equal(live.StartsAt.Add(150*time.Minute)) {
		t.Fatalf("ticket = %+v, claims = %v, meeting = %+v", ticket.Voice, claims, live)
	}
	lead.must(http.StatusOK, http.MethodPost, base+live.ID+"/voice", nil)
	expectError(t, other.do(http.MethodPost, base+live.ID+"/voice", nil), http.StatusNotFound, "not_found")

	// Who is in the call; the organizer mutes and removes.
	ts.lk.connect(lkRoom, empID, "User employee")
	var state struct {
		Enabled      bool `json:"enabled"`
		Participants []struct {
			UserID string `json:"userId"`
		} `json:"participants"`
	}
	emp.must(http.StatusOK, http.MethodGet, base+live.ID+"/voice", nil).decode(t, &state)
	if !state.Enabled || len(state.Participants) != 1 || state.Participants[0].UserID != empID {
		t.Fatalf("voice state = %+v", state)
	}
	expectError(t, emp.do(http.MethodPost, base+live.ID+"/voice/"+empID+"/mute", nil), http.StatusForbidden, "forbidden")
	lead.must(http.StatusNoContent, http.MethodPost, base+live.ID+"/voice/"+empID+"/mute", nil)
	ts.lk.waitCall(t, "mute "+lkRoom+" "+empID+" TR_")
	lead.must(http.StatusNoContent, http.MethodDelete, base+live.ID+"/voice/"+empID, nil)
	ts.lk.waitCall(t, "remove "+lkRoom+" "+empID)

	// Someone not invited who reaches LiveKit is removed when LiveKit reports it; an
	// invitee is not. Invitees hear who is in the call, by meeting.
	ts.lk.resetCalls()
	empEvents := emp.events()
	ts.lk.connect(lkRoom, otherID, "User developer")
	joined := func(id string) string {
		return `{"event":"participant_joined","room":{"name":"` + lkRoom + `"},"participant":{"identity":"` + id + `"}}`
	}
	if resp := ts.webhook(joined(otherID)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("webhook status %d", resp.StatusCode)
	}
	ts.lk.waitCall(t, "remove "+lkRoom+" "+otherID)
	var voice struct {
		MeetingID string `json:"meetingId"`
		RoomID    string `json:"roomId"`
	}
	if err := json.Unmarshal(empEvents.waitFor("voice.updated", roomEvent(live.ID)).Data, &voice); err != nil ||
		voice.MeetingID != live.ID || voice.RoomID != "" {
		t.Fatalf("voice.updated = %+v, %v", voice, err)
	}
	ts.webhook(joined(empID))
	if ts.lk.called("remove " + lkRoom + " " + empID) {
		t.Fatal("an invitee was removed from the call")
	}

	// Taking someone off the list disconnects them at once.
	lead.patchMeeting(orgID, live.ID, map[string]any{"inviteeIds": []string{}})
	ts.lk.waitCall(t, "remove "+lkRoom+" "+empID)
	lead.patchMeeting(orgID, live.ID, map[string]any{"inviteeIds": []string{empID}})

	// Canceling closes the meeting: no tokens, everyone disconnected, invitees told.
	ts.lk.resetCalls()
	empEvents = emp.events()
	lead.must(http.StatusOK, http.MethodDelete, base+live.ID, nil)
	empEvents.waitFor("meeting.updated", roomEvent(live.ID))
	ts.lk.waitCall(t, "remove "+lkRoom+" "+empID)
	expectError(t, emp.do(http.MethodPost, base+live.ID+"/voice", nil), http.StatusConflict, "meeting_canceled")
	expectCalendar(t, calendar(t, ts.mail.Next(t, "emp@example.com", "meeting_canceled")), "METHOD:CANCEL")

	// After the window closes nobody joins, and the meeting is in the past.
	if _, err := ts.db.Exec(t.Context(), `UPDATE meetings SET starts_at = now() - interval '3 hours' WHERE id = $1`, soon.ID); err != nil {
		t.Fatal(err)
	}
	expectError(t, emp.do(http.MethodPost, base+soon.ID+"/voice", nil), http.StatusConflict, "meeting_ended")
	if l := emp.meetings(orgID, "?range=past"); len(l) != 1 || l[0].ID != soon.ID {
		t.Fatalf("past meetings = %+v", l)
	}
}

// An invitation is all it takes to join, guests included; a meeting outlives its
// organizer leaving the workspace, and invitees who leave lose their invitation.
func TestMeetingMembership(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	lead, leadID := ts.join(owner, orgID, "lead@example.com", "team-leader")
	guest, guestID := ts.join(owner, orgID, "guest@example.com", "guest")
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	base := "/api/v1/orgs/" + orgID + "/meetings/"
	mt := lead.createMeeting(orgID, map[string]any{"title": "Devir", "startsAt": time.Now(), "inviteeIds": []string{guestID, empID}})
	guest.must(http.StatusOK, http.MethodPost, base+mt.ID+"/voice", nil)

	owner.must(http.StatusNoContent, http.MethodDelete, "/api/v1/orgs/"+orgID+"/members/"+leadID, nil)
	var got struct {
		Meeting meeting `json:"meeting"`
	}
	guest.must(http.StatusOK, http.MethodGet, base+mt.ID, nil).decode(t, &got)
	if got.Meeting.Organizer != nil || got.Meeting.IsOrganizer || len(got.Meeting.Invitees) != 2 {
		t.Fatalf("meeting after its organizer left = %+v", got.Meeting)
	}
	emp.must(http.StatusOK, http.MethodPost, base+mt.ID+"/voice", nil)

	owner.must(http.StatusNoContent, http.MethodDelete, "/api/v1/orgs/"+orgID+"/members/"+empID, nil)
	guest.must(http.StatusOK, http.MethodGet, base+mt.ID, nil).decode(t, &got)
	if len(got.Meeting.Invitees) != 1 || got.Meeting.Invitees[0].ID != guestID {
		t.Fatalf("invitees after one left = %+v", got.Meeting.Invitees)
	}
}

// The sweep disconnects whoever may not be in a call, for meetings and rooms alike.
func TestVoiceSweep(t *testing.T) {
	ts := newServer(t, func(d *server.Deps) { d.SweepEvery = 100 * time.Millisecond })
	owner, orgID := ts.setupInstance()
	_, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	_, otherID := ts.join(owner, orgID, "other@example.com", "developer")
	mt := owner.createMeeting(orgID, map[string]any{"title": "Kontrol", "startsAt": time.Now(), "inviteeIds": []string{empID}})
	rm := owner.createRoom(orgID, map[string]any{"name": "Ses", "access": "open"})
	lkMeeting, lkRoom := "fudislte-meeting-"+mt.ID, "fudislte-"+rm.ID

	ts.lk.connect(lkMeeting, empID, "User employee")
	ts.lk.connect(lkMeeting, otherID, "User developer")
	ts.lk.connect(lkRoom, otherID, "User developer") // never entered the room
	ts.lk.waitCall(t, "remove "+lkMeeting+" "+otherID)
	ts.lk.waitCall(t, "remove "+lkRoom+" "+otherID)
	if ts.lk.called("remove " + lkMeeting + " " + empID) {
		t.Fatal("the sweep removed an invitee")
	}

	// Once the join window closes, the call empties.
	if _, err := ts.db.Exec(t.Context(), `UPDATE meetings SET starts_at = now() - interval '3 hours' WHERE id = $1`, mt.ID); err != nil {
		t.Fatal(err)
	}
	ts.lk.waitCall(t, "remove "+lkMeeting+" "+empID)
}
