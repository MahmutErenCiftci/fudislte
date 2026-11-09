package mail

import (
	"bytes"
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"
	"testing"
	"time"

	"fudislte/api/internal/i18n"
)

func TestTemplatesRenderTextAndHTML(t *testing.T) {
	m := LoginCode(i18n.Turkish, "dana@example.com", "12345678", "https://fudislte.example.com")
	if m.Subject != "FUDISLTE giriş kodunuz" || !strings.Contains(m.Body, "    1234 5678\n") {
		t.Fatalf("text = %q / %q", m.Subject, m.Body)
	}
	for _, want := range []string{`<html lang="tr">`, "1234 5678", "Kod 10 dakika geçerlidir"} {
		if !strings.Contains(m.HTML, want) {
			t.Errorf("HTML lacks %q", want)
		}
	}

	// Values are escaped: a workspace name cannot inject markup into the email.
	inv := Invitation(i18n.English, "x@example.com", `<script>alert(1)</script> Ltd`, "Alex", "Employee",
		"https://fudislte.example.com/invite/abc", time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC))
	if strings.Contains(inv.HTML, "<script>") || !strings.Contains(inv.HTML, "&lt;script&gt;") {
		t.Fatal("organization name not escaped in HTML")
	}
	if !strings.Contains(inv.HTML, `href="https://fudislte.example.com/invite/abc"`) || !strings.Contains(inv.Body, "https://fudislte.example.com/invite/abc\n") {
		t.Fatal("invitation link missing")
	}
}

func TestBuildSendsMultipartAlternative(t *testing.T) {
	s, err := NewSMTPSender(SMTPConfig{Host: "smtp.example.com", Port: 587, TLS: "starttls", From: "FUDISLTE <fudislte@example.com>"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := s.build(LoginCode(i18n.English, "dana@example.com", "12345678", "https://fudislte.example.com"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	mediaType, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/alternative" {
		t.Fatalf("content type %q: %v", mediaType, err)
	}
	r := multipart.NewReader(msg.Body, params["boundary"])
	var kinds []string
	for {
		p, err := r.NextPart()
		if err != nil {
			break
		}
		kinds = append(kinds, strings.SplitN(p.Header.Get("Content-Type"), ";", 2)[0])
	}
	if strings.Join(kinds, ",") != "text/plain,text/html" {
		t.Fatalf("parts = %v", kinds)
	}
}

// With attachments, the text alternatives stay together as the first part of a
// multipart/mixed message and each file follows, base64-encoded.
func TestBuildNestsAlternativeInMixedWithAttachments(t *testing.T) {
	s, err := NewSMTPSender(SMTPConfig{Host: "smtp.example.com", Port: 587, TLS: "starttls", From: "FUDISLTE <fudislte@example.com>"})
	if err != nil {
		t.Fatal(err)
	}
	ics := []byte(strings.Repeat("BEGIN:VCALENDAR — ğüşıöç\r\n", 10))
	m := Message{To: "dana@example.com", Subject: "Toplantı", Body: "Metin", HTML: "<p>Metin</p>",
		Attachments: []Attachment{{Name: "invite.ics", ContentType: `text/calendar; charset="utf-8"; method=REQUEST`, Data: ics}}}
	raw, err := s.build(m, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	mediaType, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/mixed" {
		t.Fatalf("content type %q: %v", mediaType, err)
	}
	r := multipart.NewReader(msg.Body, params["boundary"])

	text, err := r.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	innerType, innerParams, err := mime.ParseMediaType(text.Header.Get("Content-Type"))
	if err != nil || innerType != "multipart/alternative" || innerParams["boundary"] == params["boundary"] {
		t.Fatalf("first part %q %v: %v", innerType, innerParams, err)
	}
	inner := multipart.NewReader(text, innerParams["boundary"])
	var kinds []string
	for {
		p, err := inner.NextPart()
		if err != nil {
			break
		}
		kinds = append(kinds, strings.SplitN(p.Header.Get("Content-Type"), ";", 2)[0])
	}
	if strings.Join(kinds, ",") != "text/plain,text/html" {
		t.Fatalf("alternatives = %v", kinds)
	}

	file, err := r.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	fileType, fileParams, _ := mime.ParseMediaType(file.Header.Get("Content-Type"))
	if fileType != "text/calendar" || fileParams["method"] != "REQUEST" || file.FileName() != "invite.ics" ||
		file.Header.Get("Content-Transfer-Encoding") != "base64" {
		t.Fatalf("attachment headers = %v", file.Header)
	}
	encoded, _ := io.ReadAll(file)
	for _, line := range strings.Split(strings.TrimSpace(string(encoded)), "\r\n") {
		if len(line) > 76 {
			t.Fatalf("base64 line of %d characters", len(line))
		}
	}
	data, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(string(encoded), "\r\n", ""))
	if err != nil || !bytes.Equal(data, ics) {
		t.Fatalf("attachment data differs: %v", err)
	}
	if _, err := r.NextPart(); err != io.EOF {
		t.Fatalf("expected the end of the message, got %v", err)
	}

	// A file name cannot carry extra header lines.
	m.Attachments[0].Name = "invite.ics\r\nBcc: victim@example.com"
	if _, err := s.build(m, time.Now()); err == nil {
		t.Fatal("expected an attachment name with a line break to be rejected")
	}
}

func TestMeetingEmails(t *testing.T) {
	istanbul, err := time.LoadLocation("Europe/Istanbul")
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC) // 12:00 in Istanbul
	m := Meeting{
		UID: "0190-abc@fudislte.example.com", Sequence: 2, Title: `Sprint <Planlama>`, Agenda: "1. Hedefler\n2. Riskler",
		Start: start, End: start.Add(time.Hour), TimeZone: istanbul,
		Organizer: "Alex Owner", OrganizerEmail: "owner@example.com", Link: "https://fudislte.example.com/w/acme/m/0190-abc",
	}
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)

	inv := MeetingInvitation(i18n.Turkish, "dana@example.com", "Dana", m, now)
	if inv.Kind != "meeting_invitation" || inv.Subject != "Toplantı daveti: Sprint <Planlama>" {
		t.Fatalf("invitation = %q %q", inv.Kind, inv.Subject)
	}
	for _, want := range []string{
		"Alex Owner sizi FUDISLTE'de bir toplantıya davet etti.",
		"Zaman: 3 Kasım 2026 Salı, 12:00–13:00 (Europe/Istanbul)\n",
		"Gündem:\n1. Hedefler\n2. Riskler\n",
		"https://fudislte.example.com/w/acme/m/0190-abc\n",
	} {
		if !strings.Contains(inv.Body, want) {
			t.Errorf("text lacks %q:\n%s", want, inv.Body)
		}
	}
	if strings.Contains(inv.HTML, "<Planlama>") || !strings.Contains(inv.HTML, "Sprint &lt;Planlama&gt;") {
		t.Fatal("meeting title not escaped in HTML")
	}
	if len(inv.Attachments) != 1 || inv.Attachments[0].Name != "invite.ics" ||
		inv.Attachments[0].ContentType != `text/calendar; charset="utf-8"; method=REQUEST` {
		t.Fatalf("attachments = %+v", inv.Attachments)
	}
	ics := strings.ReplaceAll(string(inv.Attachments[0].Data), "\r\n ", "") // unfolded
	for _, want := range []string{"METHOD:REQUEST\r\n", "UID:0190-abc@fudislte.example.com\r\n", "SEQUENCE:2\r\n",
		"DTSTART:20261103T090000Z\r\n", "DTEND:20261103T100000Z\r\n", "DTSTAMP:20261030T120000Z\r\n",
		"ATTENDEE;CN=\"Dana\";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:dana@example.com\r\n"} {
		if !strings.Contains(ics, want) {
			t.Errorf("calendar file lacks %q:\n%s", want, ics)
		}
	}

	en := MeetingUpdated(i18n.English, "sam@example.com", "Sam", m, now)
	if en.Kind != "meeting_updated" || en.Subject != "Updated: Sprint <Planlama>" ||
		!strings.Contains(en.Body, "When: Tuesday, November 3, 2026, 12:00–13:00 (Europe/Istanbul)\n") {
		t.Fatalf("update = %q\n%s", en.Subject, en.Body)
	}

	for _, c := range []Message{
		MeetingCanceled(i18n.English, "sam@example.com", "Sam", m, now),
		MeetingRemoved(i18n.Turkish, "dana@example.com", "Dana", m, now),
	} {
		ics := string(c.Attachments[0].Data)
		if c.Attachments[0].Name != "cancel.ics" || !strings.Contains(ics, "METHOD:CANCEL\r\n") ||
			!strings.Contains(ics, "STATUS:CANCELLED\r\n") || strings.Contains(c.Body, m.Link) {
			t.Fatalf("%s: %q\n%s", c.Kind, c.Body, ics)
		}
	}
}
