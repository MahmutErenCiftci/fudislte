package mail

import (
	"bytes"
	"fmt"
	"html/template"
	"strings"
	"time"

	"fudislte/api/internal/i18n"
)

// FormatCode groups an 8-digit code as "1234 5678" for readability.
func FormatCode(code string) string {
	if len(code) != 8 {
		return code
	}
	return code[:4] + " " + code[4:]
}

// content is one email, rendered both as plain text and as HTML. Every value is text;
// html/template escapes it.
type content struct {
	Lang     string
	Title    string
	Intro    string
	Code     string
	Facts    []fact
	LinkText string
	Link     string
	Notes    []string
}

// fact is a labelled detail such as a meeting's time; values keep their line breaks.
type fact struct {
	Label string
	Value string
}

func (c content) text() string {
	var b strings.Builder
	b.WriteString(c.Intro + "\n\n")
	if c.Code != "" {
		b.WriteString("    " + c.Code + "\n\n")
	}
	if len(c.Facts) > 0 {
		for _, f := range c.Facts {
			if strings.Contains(f.Value, "\n") {
				b.WriteString(f.Label + ":\n" + f.Value + "\n")
			} else {
				b.WriteString(f.Label + ": " + f.Value + "\n")
			}
		}
		b.WriteString("\n")
	}
	if c.Link != "" {
		b.WriteString(c.LinkText + "\n" + c.Link + "\n\n")
	}
	b.WriteString(strings.Join(c.Notes, "\n") + "\n")
	return b.String()
}

// The HTML version uses inline styles and tables only, which every mail client renders.
var page = template.Must(template.New("email").Parse(`<!doctype html>
<html lang="{{.Lang}}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{.Title}}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px">
<tr><td style="padding:28px 32px 8px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:32px;height:32px;background:#2563eb;border-radius:8px;color:#ffffff;font-weight:700;font-size:18px;text-align:center;line-height:32px">N</td>
<td style="padding-left:10px;font-size:18px;font-weight:700">FUDISLTE</td>
</tr></table>
</td></tr>
<tr><td style="padding:16px 32px 0">
<h1 style="margin:0 0 12px;font-size:20px;line-height:28px">{{.Title}}</h1>
<p style="margin:0;font-size:15px;line-height:23px;color:#334155">{{.Intro}}</p>
</td></tr>
{{if .Code}}<tr><td style="padding:20px 32px 4px">
<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:16px;text-align:center;font-family:'SFMono-Regular',Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:4px;color:#1d4ed8">{{.Code}}</div>
</td></tr>{{end}}
{{if .Facts}}<tr><td style="padding:20px 32px 4px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">
{{range .Facts}}<tr><td style="padding:10px 14px;font-size:14px;line-height:21px;color:#0f172a"><span style="display:block;font-size:12px;color:#64748b">{{.Label}}</span><span style="white-space:pre-wrap">{{.Value}}</span></td></tr>{{end}}
</table>
</td></tr>{{end}}
{{if .Link}}<tr><td style="padding:20px 32px 4px">
<a href="{{.Link}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:8px">{{.LinkText}}</a>
<p style="margin:12px 0 0;font-size:12px;line-height:18px;color:#64748b;word-break:break-all">{{.Link}}</p>
</td></tr>{{end}}
<tr><td style="padding:20px 32px 28px">
{{range .Notes}}<p style="margin:0 0 6px;font-size:13px;line-height:20px;color:#64748b">{{.}}</p>{{end}}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`))

func (c content) html() string {
	var b bytes.Buffer
	if err := page.Execute(&b, c); err != nil {
		// The template is fixed and its data plain strings; the text part still goes out.
		return ""
	}
	return b.String()
}

func message(to, kind, subject string, c content) Message {
	c.Title = subject
	return Message{To: to, Kind: kind, Subject: subject, Body: c.text(), HTML: c.html()}
}

func codeNotes(l i18n.Locale) []string {
	return []string{
		i18n.T(l, "The code expires in 10 minutes and works once."),
		i18n.T(l, "If you did not request it, you can ignore this email. Never share this code with anyone."),
	}
}

// Each template takes the recipient's language: the account's for people who have one,
// otherwise the language of the request that triggered the email.

func LoginCode(l i18n.Locale, to, code, publicURL string) Message {
	return message(to, "login_code", i18n.T(l, "Your FUDISLTE sign-in code"), content{
		Lang:  string(l),
		Intro: i18n.Tf(l, "Use this code to sign in to FUDISLTE at %s:", publicURL),
		Code:  FormatCode(code),
		Notes: codeNotes(l),
	})
}

func SetupCode(l i18n.Locale, to, code, publicURL string) Message {
	return message(to, "setup_code", i18n.T(l, "Confirm your email to finish setting up FUDISLTE"), content{
		Lang:  string(l),
		Intro: i18n.Tf(l, "Use this code to confirm your email and finish setting up FUDISLTE at %s:", publicURL),
		Code:  FormatCode(code),
		Notes: append([]string{i18n.T(l, "Receiving this email also confirms that the server can send mail.")}, codeNotes(l)...),
	})
}

func InvitationCode(l i18n.Locale, to, code, orgName string) Message {
	return message(to, "invitation_code", i18n.Tf(l, "Your code to join %s on FUDISLTE", orgName), content{
		Lang:  string(l),
		Intro: i18n.Tf(l, "Use this code to confirm your email and join %s:", orgName),
		Code:  FormatCode(code),
		Notes: codeNotes(l),
	})
}

func Invitation(l i18n.Locale, to, orgName, inviter, role, link string, expires time.Time) Message {
	return message(to, "invitation", i18n.Tf(l, "%s invited you to %s on FUDISLTE", inviter, orgName), content{
		Lang:     string(l),
		Intro:    i18n.Tf(l, "%s invited you to join %s on FUDISLTE as %s.", inviter, orgName, role),
		LinkText: i18n.T(l, "Open this link to join:"),
		Link:     link,
		Notes: []string{i18n.Tf(l, "The link works once and expires on %s. You will confirm your email with a one-time code; no password is needed.",
			expires.UTC().Format("2006-01-02 15:04 UTC"))},
	})
}

// Meeting is what a meeting email shows and its calendar file carries.
type Meeting struct {
	// UID identifies the meeting in calendars for its whole life; Sequence orders the
	// versions sent (see CalendarEvent).
	UID      string
	Sequence int
	Title    string
	Agenda   string
	Start    time.Time
	End      time.Time
	// TimeZone is the organizer's. The text shows times in it; the calendar file uses
	// UTC, so calendars show each recipient's local time.
	TimeZone       *time.Location
	Organizer      string
	OrganizerEmail string
	// Link opens the meeting in FUDISLTE.
	Link string
}

// MeetingInvitation invites name to a meeting; its calendar file adds the meeting to
// their calendar.
func MeetingInvitation(l i18n.Locale, to, name string, m Meeting, now time.Time) Message {
	return meetingMessage(l, to, name, "meeting_invitation", i18n.Tf(l, "Invitation: %s", m.Title),
		i18n.Tf(l, "%s invited you to a meeting on FUDISLTE.", m.Organizer), m, false, now)
}

// MeetingUpdated sends invitees a meeting's new time.
func MeetingUpdated(l i18n.Locale, to, name string, m Meeting, now time.Time) Message {
	return meetingMessage(l, to, name, "meeting_updated", i18n.Tf(l, "Updated: %s", m.Title),
		i18n.Tf(l, "%s changed the time of this meeting.", m.Organizer), m, false, now)
}

// MeetingCanceled tells invitees a meeting will not take place; its calendar file
// removes the meeting from their calendar.
func MeetingCanceled(l i18n.Locale, to, name string, m Meeting, now time.Time) Message {
	return meetingMessage(l, to, name, "meeting_canceled", i18n.Tf(l, "Canceled: %s", m.Title),
		i18n.Tf(l, "%s canceled this meeting.", m.Organizer), m, true, now)
}

// MeetingRemoved tells someone taken off a meeting's invitation list; for their
// calendar it is a cancellation.
func MeetingRemoved(l i18n.Locale, to, name string, m Meeting, now time.Time) Message {
	return meetingMessage(l, to, name, "meeting_removed", i18n.Tf(l, "No longer invited: %s", m.Title),
		i18n.Tf(l, "%s removed you from this meeting.", m.Organizer), m, true, now)
}

func meetingMessage(l i18n.Locale, to, name, kind, subject, intro string, m Meeting, cancel bool, now time.Time) Message {
	c := content{
		Lang:  string(l),
		Intro: intro,
		Facts: []fact{
			{i18n.T(l, "Meeting"), m.Title},
			{i18n.T(l, "When"), MeetingTime(l, m.Start, m.End, m.TimeZone)},
			{i18n.T(l, "Organizer"), m.Organizer},
		},
	}
	if cancel {
		c.Notes = []string{i18n.T(l, "The attached calendar file removes the meeting from your calendar.")}
	} else {
		if m.Agenda != "" {
			c.Facts = append(c.Facts, fact{i18n.T(l, "Agenda"), m.Agenda})
		}
		c.LinkText = i18n.T(l, "Open the meeting:")
		c.Link = m.Link
		c.Notes = []string{
			i18n.T(l, "Only invited people can join, from 15 minutes before the start."),
			i18n.T(l, "The attached calendar file adds the meeting to your calendar."),
		}
	}
	msg := message(to, kind, subject, c)
	ev := CalendarEvent{
		UID: m.UID, Sequence: m.Sequence, Cancel: cancel, Start: m.Start, End: m.End,
		Summary: m.Title, URL: m.Link, Stamp: now,
		Organizer: CalendarPerson{Name: m.Organizer, Email: m.OrganizerEmail},
		Attendee:  CalendarPerson{Name: name, Email: to},
	}
	if !cancel {
		ev.Description = strings.TrimSpace(m.Agenda + "\n\n" + m.Link)
	}
	msg.Attachments = []Attachment{ev.Attachment()}
	return msg
}

// MeetingTime writes a meeting's date and hours in loc, the way each language writes
// dates: "3 Kasım 2026 Salı, 12:00–13:00 (Europe/Istanbul)", "Tuesday, November 3,
// 2026, 12:00–13:00 (Europe/Istanbul)".
func MeetingTime(l i18n.Locale, start, end time.Time, loc *time.Location) string {
	if loc == nil {
		loc = time.UTC
	}
	s, e := start.In(loc), end.In(loc)
	weekday, month := i18n.T(l, s.Weekday().String()), i18n.T(l, s.Month().String())
	day := fmt.Sprintf("%s, %s %d, %d", weekday, month, s.Day(), s.Year())
	if l == i18n.Turkish {
		day = fmt.Sprintf("%d %s %d %s", s.Day(), month, s.Year(), weekday)
	}
	return fmt.Sprintf("%s, %s–%s (%s)", day, s.Format("15:04"), e.Format("15:04"), loc)
}

// Test is sent by `fudislte-api mailtest` to check SMTP settings. The Turkish line checks
// that UTF-8 survives the relay.
func Test(to, publicURL string, now time.Time) Message {
	return message(to, "test", "FUDISLTE test email — çalışıyor", content{
		Lang:  "en",
		Intro: fmt.Sprintf("This is a test email from FUDISLTE at %s, sent %s.", publicURL, now.UTC().Format(time.RFC1123)),
		Notes: []string{
			"If you can read this, sign-in codes and invitations will be delivered too.",
			"UTF-8 check: Türkçe karakterler ğüşıöç ĞÜŞİÖÇ",
		},
	})
}
