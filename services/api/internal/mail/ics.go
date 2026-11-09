package mail

import (
	"bytes"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Calendar files (iCalendar, RFC 5545) for meeting invitations, using iTIP methods
// (RFC 5546): REQUEST adds or updates the event in the recipient's calendar, CANCEL
// removes it. Times are written in UTC, so every calendar shows them in local time.

// CalendarEvent is one meeting as a calendar request or cancellation for one recipient.
type CalendarEvent struct {
	// UID stays the same for the life of the meeting; Sequence grows with every new
	// time and with the cancellation, so calendars replace older copies.
	UID      string
	Sequence int
	// Cancel makes the file a cancellation (METHOD:CANCEL).
	Cancel      bool
	Start, End  time.Time
	Summary     string
	Description string
	// URL is the meeting's page; it is also the location, which calendars make
	// clickable.
	URL       string
	Organizer CalendarPerson
	// Attendee is the recipient. Other invitees are not listed, so the file does not
	// reveal their addresses.
	Attendee CalendarPerson
	// Stamp is when the file was created.
	Stamp time.Time
}

type CalendarPerson struct {
	Name  string
	Email string
}

func (e CalendarEvent) method() string {
	if e.Cancel {
		return "CANCEL"
	}
	return "REQUEST"
}

// Attachment returns the event as the calendar file of an email.
func (e CalendarEvent) Attachment() Attachment {
	name := "invite.ics"
	if e.Cancel {
		name = "cancel.ics"
	}
	return Attachment{
		Name:        name,
		ContentType: `text/calendar; charset="utf-8"; method=` + e.method(),
		Data:        e.Bytes(),
	}
}

// Bytes renders the event as an iCalendar file with CRLF line endings and long lines
// folded at 75 octets.
func (e CalendarEvent) Bytes() []byte {
	var b bytes.Buffer
	line := func(s string) { writeFolded(&b, s) }
	status := "CONFIRMED"
	if e.Cancel {
		status = "CANCELLED"
	}
	line("BEGIN:VCALENDAR")
	line("PRODID:-//FUDISLTE//Meetings//EN")
	line("VERSION:2.0")
	line("CALSCALE:GREGORIAN")
	line("METHOD:" + e.method())
	line("BEGIN:VEVENT")
	line("UID:" + icsText(e.UID))
	line("DTSTAMP:" + icsTime(e.Stamp))
	line("DTSTART:" + icsTime(e.Start))
	line("DTEND:" + icsTime(e.End))
	line(fmt.Sprintf("SEQUENCE:%d", e.Sequence))
	line("STATUS:" + status)
	line("SUMMARY:" + icsText(e.Summary))
	if e.Description != "" {
		line("DESCRIPTION:" + icsText(e.Description))
	}
	if e.URL != "" {
		line("LOCATION:" + icsText(e.URL))
		line("URL:" + e.URL)
	}
	line("ORGANIZER;CN=" + icsParam(e.Organizer.Name) + ":mailto:" + e.Organizer.Email)
	line("ATTENDEE;CN=" + icsParam(e.Attendee.Name) + ";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:" + e.Attendee.Email)
	line("TRANSP:OPAQUE")
	line("END:VEVENT")
	line("END:VCALENDAR")
	return b.Bytes()
}

func icsTime(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

// icsText escapes a TEXT value: backslashes, semicolons, commas and line breaks.
func icsText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '\\', ';', ',':
			b.WriteRune('\\')
			b.WriteRune(r)
		case '\n':
			b.WriteString(`\n`)
		default:
			if !unicode.IsControl(r) || r == '\t' {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

// icsParam quotes a parameter value such as a name; double quotes and control
// characters cannot be represented and are dropped.
func icsParam(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '"' || unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return `"` + s + `"`
}

// writeFolded appends one content line, folded so no line exceeds 75 octets; folds
// never split a UTF-8 character.
func writeFolded(b *bytes.Buffer, s string) {
	limit := 75
	for len(s) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		b.WriteString(s[:cut] + "\r\n ")
		s = s[cut:]
		limit = 74 // continuation lines start with a space
	}
	b.WriteString(s + "\r\n")
}
