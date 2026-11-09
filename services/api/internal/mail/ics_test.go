package mail

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestCalendarEventEscapesAndFolds(t *testing.T) {
	start := time.Date(2026, 11, 3, 12, 0, 0, 0, time.FixedZone("TRT", 3*60*60))
	ev := CalendarEvent{
		UID: "m-1@fudislte.example.com", Sequence: 1, Start: start, End: start.Add(90 * time.Minute),
		Summary:     "Bütçe; plan, \\ gözden geçirme",
		Description: "Satır bir\r\nSatır iki " + strings.Repeat("ğüşıöç", 20),
		URL:         "https://fudislte.example.com/w/acme/m/m-1",
		Organizer:   CalendarPerson{Name: `Alex "AJ" Owner`, Email: "owner@example.com"},
		Attendee:    CalendarPerson{Name: "Dana", Email: "dana@example.com"},
		Stamp:       time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC),
	}
	out := string(ev.Bytes())
	if !strings.HasSuffix(out, "END:VCALENDAR\r\n") || strings.Contains(strings.ReplaceAll(out, "\r\n", ""), "\n") {
		t.Fatalf("lines must end with CRLF:\n%q", out)
	}
	for _, line := range strings.Split(strings.TrimSuffix(out, "\r\n"), "\r\n") {
		if len(line) > 75 || !utf8.ValidString(line) {
			t.Fatalf("line of %d octets or split character: %q", len(line), line)
		}
	}
	// Unfolding (RFC 5545 3.1) restores the escaped values.
	unfolded := strings.ReplaceAll(out, "\r\n ", "")
	for _, want := range []string{
		"DTSTART:20261103T090000Z\r\n",
		"DTEND:20261103T103000Z\r\n",
		`SUMMARY:Bütçe\; plan\, \\ gözden geçirme` + "\r\n",
		`DESCRIPTION:Satır bir\nSatır iki ğüşıöç`,
		"ORGANIZER;CN=\"Alex AJ Owner\":mailto:owner@example.com\r\n",
		"LOCATION:https://fudislte.example.com/w/acme/m/m-1\r\n",
		"STATUS:CONFIRMED\r\n",
	} {
		if !strings.Contains(unfolded, want) {
			t.Errorf("calendar file lacks %q:\n%s", want, unfolded)
		}
	}

	ev.Cancel, ev.Sequence = true, 2
	a := ev.Attachment()
	cancel := string(a.Data)
	if a.Name != "cancel.ics" || a.ContentType != `text/calendar; charset="utf-8"; method=CANCEL` ||
		!strings.Contains(cancel, "METHOD:CANCEL\r\n") || !strings.Contains(cancel, "STATUS:CANCELLED\r\n") ||
		!strings.Contains(cancel, "SEQUENCE:2\r\n") || !strings.Contains(cancel, "UID:m-1@fudislte.example.com\r\n") {
		t.Fatalf("cancellation = %s\n%s", a.ContentType, cancel)
	}
}
