package chat

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	_ "time/tzdata" // time zone names are checked the same way on every system image
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
	"fudislte/api/internal/mail"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

// Meetings (docs/architecture/phase-4.md) are scheduled voice and video calls. Only the
// organizer and the invitees see a meeting, and they may join it from 15 minutes before
// the start until 2 hours after the scheduled end. Invitees receive the invitation,
// every new time and the cancellation by email, each with a calendar file.

const (
	joinEarly         = 15 * time.Minute
	joinLate          = 2 * time.Hour
	minMeetingMinutes = 15
	maxMeetingMinutes = 8 * 60
	maxInvitees       = 200
	maxMeetingAhead   = 366 * 24 * time.Hour
	// startGrace accepts a start slightly in the past: "now", picked in a form.
	startGrace = 5 * time.Minute
	// meetingPage bounds both lists; upcoming meetings are soonest first, past ones
	// most recent first.
	meetingPage = 100
)

var (
	errMeetingCanceled   = httpx.NewError(http.StatusConflict, "meeting_canceled", "This meeting was canceled.")
	errMeetingNotStarted = httpx.NewError(http.StatusConflict, "meeting_not_started", "The meeting opens 15 minutes before it starts.")
	errMeetingEnded      = httpx.NewError(http.StatusConflict, "meeting_ended", "This meeting has ended.")
)

// SetMail lets the service email meeting invitations; their links start with publicURL.
func (s *Service) SetMail(outbox *mail.Outbox, publicURL string) {
	s.outbox, s.publicURL = outbox, publicURL
}

// Meeting is a meeting as its organizer or an invitee sees it.
type Meeting struct {
	ID              uuid.UUID `json:"id"`
	Title           string    `json:"title"`
	Agenda          string    `json:"agenda"`
	StartsAt        time.Time `json:"startsAt"`
	DurationMinutes int       `json:"durationMinutes"`
	EndsAt          time.Time `json:"endsAt"`
	// TimeZone is the organizer's IANA time zone; emails write times in it.
	TimeZone string `json:"timeZone"`
	// Organizer is nil once the organizer has left the workspace.
	Organizer *Author `json:"organizer"`
	// Invitees are sorted by name; the organizer is not one of them.
	Invitees   []Author   `json:"invitees"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	CanceledAt *time.Time `json:"canceledAt"`
	// OpensAt and ClosesAt bound the join window.
	OpensAt  time.Time `json:"opensAt"`
	ClosesAt time.Time `json:"closesAt"`
	// IsOrganizer is set for the caller who may edit, cancel and moderate the meeting.
	IsOrganizer bool `json:"isOrganizer"`

	sequence int
}

// meetingQuery loads meetings of the workspace ($1) that the caller ($2) organizes or
// is invited to.
const meetingQuery = `
	SELECT mt.id, mt.title, mt.agenda, mt.starts_at, mt.duration_minutes, mt.time_zone, mt.sequence,
	       mt.created_at, mt.updated_at, mt.canceled_at, o.id, o.display_name
	FROM meetings mt
	LEFT JOIN users o ON o.id = mt.organizer_id
	WHERE mt.org_id = $1 AND mt.id IN (
	    SELECT id FROM meetings WHERE org_id = $1 AND organizer_id = $2
	    UNION SELECT meeting_id FROM meeting_invitees WHERE org_id = $1 AND user_id = $2)`

func queryMeetings(ctx context.Context, q database.Querier, m *org.Membership, filter string, args ...any) ([]Meeting, error) {
	rows, err := q.Query(ctx, meetingQuery+filter, append([]any{m.Org.ID, m.UserID}, args...)...)
	if err != nil {
		return nil, err
	}
	meetings, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Meeting, error) {
		var (
			mt            Meeting
			organizerID   *uuid.UUID
			organizerName *string
		)
		err := row.Scan(&mt.ID, &mt.Title, &mt.Agenda, &mt.StartsAt, &mt.DurationMinutes, &mt.TimeZone, &mt.sequence,
			&mt.CreatedAt, &mt.UpdatedAt, &mt.CanceledAt, &organizerID, &organizerName)
		if organizerID != nil && organizerName != nil {
			mt.Organizer = &Author{ID: *organizerID, DisplayName: *organizerName}
		}
		return mt, err
	})
	if err != nil {
		return nil, err
	}
	if err := fillInvitees(ctx, q, meetings); err != nil {
		return nil, err
	}
	for i := range meetings {
		meetings[i].settle(m.UserID)
	}
	return meetings, nil
}

// fillInvitees names each meeting's invitees.
func fillInvitees(ctx context.Context, q database.Querier, meetings []Meeting) error {
	if len(meetings) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(meetings))
	index := make(map[uuid.UUID]int, len(meetings))
	for i := range meetings {
		ids[i] = meetings[i].ID
		index[meetings[i].ID] = i
		meetings[i].Invitees = []Author{}
	}
	rows, err := q.Query(ctx, `
		SELECT mi.meeting_id, u.id, u.display_name
		FROM meeting_invitees mi JOIN users u ON u.id = mi.user_id
		WHERE mi.meeting_id = ANY ($1)
		ORDER BY lower(u.display_name), u.id`, ids)
	if err != nil {
		return err
	}
	var (
		meetingID uuid.UUID
		a         Author
	)
	_, err = pgx.ForEachRow(rows, []any{&meetingID, &a.ID, &a.DisplayName}, func() error {
		i := index[meetingID]
		meetings[i].Invitees = append(meetings[i].Invitees, a)
		return nil
	})
	return err
}

// settle works out the end, the join window and whether userID organizes the meeting.
func (mt *Meeting) settle(userID uuid.UUID) {
	mt.EndsAt = mt.StartsAt.Add(time.Duration(mt.DurationMinutes) * time.Minute)
	mt.OpensAt = mt.StartsAt.Add(-joinEarly)
	mt.ClosesAt = mt.EndsAt.Add(joinLate)
	mt.IsOrganizer = mt.Organizer != nil && mt.Organizer.ID == userID
}

// joinable reports why nobody may join the meeting at now, or nil when it is open.
func (mt *Meeting) joinable(now time.Time) error {
	switch {
	case mt.CanceledAt != nil:
		return errMeetingCanceled
	case now.Before(mt.OpensAt):
		return errMeetingNotStarted
	case !now.Before(mt.ClosesAt):
		return errMeetingEnded
	}
	return nil
}

// people are the organizer and the invitees: who hears about the meeting's changes.
func (mt *Meeting) people() []uuid.UUID {
	ids := authorIDs(mt.Invitees)
	if mt.Organizer != nil {
		ids = append(ids, mt.Organizer.ID)
	}
	return ids
}

func authorIDs(authors []Author) []uuid.UUID {
	ids := make([]uuid.UUID, len(authors))
	for i, a := range authors {
		ids[i] = a.ID
	}
	return ids
}

// loadMeeting returns the {meetingID} meeting if the caller organizes it or is invited;
// httpx.ErrNotFound otherwise, so nobody else learns that it exists.
func (s *Service) loadMeeting(r *http.Request) (*org.Membership, *Meeting, error) {
	m := org.MembershipFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "meetingID"))
	if err != nil {
		return m, nil, httpx.ErrNotFound
	}
	mt, err := s.meetingByID(r.Context(), m, id)
	return m, mt, err
}

func (s *Service) meetingByID(ctx context.Context, m *org.Membership, id uuid.UUID) (*Meeting, error) {
	meetings, err := queryMeetings(ctx, s.db, m, ` AND mt.id = $3`, id)
	if err != nil {
		return nil, err
	}
	if len(meetings) == 0 {
		return nil, httpx.ErrNotFound
	}
	return &meetings[0], nil
}

// organizedMeeting is loadMeeting for what only the organizer may do.
func (s *Service) organizedMeeting(r *http.Request) (*org.Membership, *Meeting, error) {
	m, mt, err := s.loadMeeting(r)
	if err == nil && !mt.IsOrganizer {
		err = httpx.ErrForbidden
	}
	return m, mt, err
}

// ListMeetings returns the caller's meetings: ?range=upcoming (default; not yet ended,
// soonest first) or past (most recent first). Canceled meetings stay listed.
func (s *Service) ListMeetings(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	const end = `mt.starts_at + make_interval(mins => mt.duration_minutes)`
	var filter string
	switch r.URL.Query().Get("range") {
	case "", "upcoming":
		filter = ` AND ` + end + ` > now() ORDER BY mt.starts_at, mt.id`
	case "past":
		filter = ` AND ` + end + ` <= now() ORDER BY mt.starts_at DESC, mt.id DESC`
	default:
		return httpx.Invalid(map[string]string{"range": "Choose a valid filter."})
	}
	meetings, err := queryMeetings(r.Context(), s.db, m, filter+` LIMIT $3`, meetingPage)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"meetings": meetings})
	return nil
}

func (s *Service) GetMeeting(w http.ResponseWriter, r *http.Request) error {
	_, mt, err := s.loadMeeting(r)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"meeting": mt})
	return nil
}

// meetingInput is the body of POST and PATCH; absent fields keep their value.
type meetingInput struct {
	Title           *string      `json:"title"`
	Agenda          *string      `json:"agenda"`
	StartsAt        *time.Time   `json:"startsAt"`
	DurationMinutes *int         `json:"durationMinutes"`
	InviteeIDs      *[]uuid.UUID `json:"inviteeIds"`
	// TimeZone is the organizer's IANA time zone, e.g. Europe/Istanbul.
	TimeZone *string `json:"timeZone"`
}

// meetingValues are a meeting's editable fields.
type meetingValues struct {
	title, agenda, timeZone string
	startsAt                time.Time
	minutes                 int
	// invitees is nil when the input leaves them unchanged.
	invitees []uuid.UUID
}

// validate applies in to cur. A start time must lie between now and a year ahead, but
// only when it changes: past meetings stay editable.
func (in meetingInput) validate(cur meetingValues, organizerID uuid.UUID, now time.Time) (meetingValues, error) {
	v := cur
	fields := map[string]string{}
	var msg string
	if in.Title != nil {
		if v.title, msg = normalizeMeetingTitle(*in.Title); msg != "" {
			fields["title"] = msg
		}
	}
	if in.Agenda != nil {
		if v.agenda, msg = normalizeAgenda(*in.Agenda); msg != "" {
			fields["agenda"] = msg
		}
	}
	if in.StartsAt != nil {
		v.startsAt = in.StartsAt.Truncate(time.Minute)
		if !v.startsAt.Equal(cur.startsAt) && (v.startsAt.Before(now.Add(-startGrace)) || v.startsAt.After(now.Add(maxMeetingAhead))) {
			fields["startsAt"] = "Choose a start between now and one year from now."
		}
	}
	if v.startsAt.IsZero() {
		fields["startsAt"] = "Choose a start time."
	}
	if in.DurationMinutes != nil {
		v.minutes = *in.DurationMinutes
	}
	if v.minutes < minMeetingMinutes || v.minutes > maxMeetingMinutes {
		fields["durationMinutes"] = "Choose between 15 minutes and 8 hours."
	}
	if in.TimeZone != nil && *in.TimeZone != "" {
		if _, err := time.LoadLocation(*in.TimeZone); err != nil || *in.TimeZone == "Local" || len(*in.TimeZone) > 64 {
			fields["timeZone"] = "Choose a valid time zone."
		} else {
			v.timeZone = *in.TimeZone
		}
	}
	if in.InviteeIDs != nil {
		v.invitees = slices.DeleteFunc(unique(*in.InviteeIDs), func(id uuid.UUID) bool { return id == organizerID })
		if len(v.invitees) > maxInvitees {
			fields["inviteeIds"] = "Invite at most 200 people."
		}
	}
	if len(fields) > 0 {
		return v, httpx.Invalid(fields)
	}
	return v, nil
}

// normalizeMeetingTitle collapses whitespace into one line of 1 to 120 characters.
func normalizeMeetingTitle(s string) (string, string) {
	s = strings.Join(strings.Fields(s), " ")
	if n := utf8.RuneCountInString(s); n < 1 || n > 120 || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", "Use 1 to 120 characters."
	}
	return s, ""
}

// normalizeAgenda keeps line breaks and tabs, drops other control characters and
// trims surrounding blank space; an agenda may be empty.
func normalizeAgenda(s string) (string, string) {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > 2000 {
		return "", "Use at most 2000 characters."
	}
	return s, ""
}

// inviteesInWorkspace fails unless every ID belongs to a member of the workspace.
func inviteesInWorkspace(ctx context.Context, q database.Querier, orgID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	var known int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = ANY ($2)`, orgID, ids).Scan(&known); err != nil {
		return err
	}
	if known != len(ids) {
		return httpx.Invalid(map[string]string{"inviteeIds": "Invite members of this workspace."})
	}
	return nil
}

func (s *Service) CreateMeeting(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	var in meetingInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Title == nil {
		in.Title = new(string)
	}
	v, err := in.validate(meetingValues{minutes: 30, timeZone: "UTC"}, m.UserID, time.Now())
	if err != nil {
		return err
	}
	if v.invitees == nil {
		v.invitees = []uuid.UUID{}
	}
	if !s.meetingWrites.Allow(m.UserID.String()) {
		return httpx.ErrRateLimited
	}
	id := uuid.Must(uuid.NewV7())
	var invited []recipient
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := inviteesInWorkspace(ctx, tx, m.Org.ID, v.invitees); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO meetings (id, org_id, title, agenda, starts_at, duration_minutes, time_zone, organizer_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			id, m.Org.ID, v.title, v.agenda, v.startsAt, v.minutes, v.timeZone, m.UserID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO meeting_invitees (meeting_id, org_id, user_id)
			SELECT $1, $2, u FROM unnest($3::uuid[]) AS u`, id, m.Org.ID, v.invitees); err != nil {
			return err
		}
		var err error
		if invited, err = loadRecipients(ctx, tx, v.invitees); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "meeting.created")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "meeting", id.String()
		ev.Metadata = map[string]any{
			"meeting": v.title, "startsAt": v.startsAt.UTC().Format(time.RFC3339), "durationMinutes": v.minutes,
			"invitees": len(v.invitees),
		}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	mt, err := s.meetingByID(ctx, m, id)
	if err != nil {
		return err
	}
	s.mailMeeting(ctx, m, mt, invited, mail.MeetingInvitation)
	s.publishMeeting(m.Org.ID, mt, nil)
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"meeting": mt})
	return nil
}

// UpdateMeeting changes a meeting (its organizer). New invitees get the invitation; a
// new time or length bumps the calendar sequence and sends everyone else the update;
// people taken off the list get a cancellation and leave the call.
func (s *Service) UpdateMeeting(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, mt, err := s.organizedMeeting(r)
	if err != nil {
		return err
	}
	if mt.CanceledAt != nil {
		return errMeetingCanceled
	}
	var in meetingInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	cur := meetingValues{title: mt.Title, agenda: mt.Agenda, timeZone: mt.TimeZone, startsAt: mt.StartsAt, minutes: mt.DurationMinutes}
	v, err := in.validate(cur, m.UserID, time.Now())
	if err != nil {
		return err
	}
	if !s.meetingWrites.Allow(m.UserID.String()) {
		return httpx.ErrRateLimited
	}
	rescheduled := !v.startsAt.Equal(mt.StartsAt) || v.minutes != mt.DurationMinutes
	added, removed := []uuid.UUID{}, []uuid.UUID{}
	var invited, kept, uninvited []recipient
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		// The row lock orders concurrent changes; the invitation list is read under it.
		var locked uuid.UUID
		err := tx.QueryRow(ctx, `SELECT id FROM meetings WHERE id = $1 AND org_id = $2 AND canceled_at IS NULL FOR UPDATE`, mt.ID, m.Org.ID).Scan(&locked)
		if isNoRows(err) {
			return errMeetingCanceled
		}
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT user_id FROM meeting_invitees WHERE meeting_id = $1`, mt.ID)
		if err != nil {
			return err
		}
		before, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return err
		}
		after := before
		if v.invitees != nil {
			after = v.invitees
		}
		for _, id := range after {
			if !slices.Contains(before, id) {
				added = append(added, id)
			}
		}
		for _, id := range before {
			if !slices.Contains(after, id) {
				removed = append(removed, id)
			}
		}
		if err := inviteesInWorkspace(ctx, tx, m.Org.ID, added); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE meetings SET title = $2, agenda = $3, starts_at = $4, duration_minutes = $5, time_zone = $6,
			       sequence = sequence + CASE WHEN $7 THEN 1 ELSE 0 END, updated_at = now()
			WHERE id = $1`, mt.ID, v.title, v.agenda, v.startsAt, v.minutes, v.timeZone, rescheduled); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM meeting_invitees WHERE meeting_id = $1 AND user_id = ANY ($2)`, mt.ID, removed); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO meeting_invitees (meeting_id, org_id, user_id)
			SELECT $1, $2, u FROM unnest($3::uuid[]) AS u ON CONFLICT DO NOTHING`, mt.ID, m.Org.ID, added); err != nil {
			return err
		}
		if invited, err = loadRecipients(ctx, tx, added); err != nil {
			return err
		}
		if uninvited, err = loadRecipients(ctx, tx, removed); err != nil {
			return err
		}
		if rescheduled {
			stayed := slices.DeleteFunc(slices.Clone(after), func(id uuid.UUID) bool { return slices.Contains(added, id) })
			if kept, err = loadRecipients(ctx, tx, stayed); err != nil {
				return err
			}
		}

		changes := map[string]any{}
		if v.title != mt.Title {
			changes["title"] = map[string]string{"from": mt.Title, "to": v.title}
		}
		if v.agenda != mt.Agenda {
			changes["agendaChanged"] = true
		}
		if rescheduled {
			changes["startsAt"] = map[string]string{"from": mt.StartsAt.UTC().Format(time.RFC3339), "to": v.startsAt.UTC().Format(time.RFC3339)}
			changes["durationMinutes"] = map[string]int{"from": mt.DurationMinutes, "to": v.minutes}
		}
		if len(added) > 0 || len(removed) > 0 {
			changes["added"], changes["removed"] = added, removed
		}
		if len(changes) == 0 {
			return nil
		}
		changes["meeting"] = v.title
		ev := audit.FromRequest(r, "meeting.updated")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "meeting", mt.ID.String()
		ev.Metadata = changes
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	updated, err := s.meetingByID(ctx, m, mt.ID)
	if err != nil {
		return err
	}
	s.mailMeeting(ctx, m, updated, invited, mail.MeetingInvitation)
	s.mailMeeting(ctx, m, updated, kept, mail.MeetingUpdated)
	s.mailMeeting(ctx, m, updated, uninvited, mail.MeetingRemoved)
	s.publishMeeting(m.Org.ID, updated, removed)
	if rescheduled || len(removed) > 0 {
		s.enforceVoiceLater(voiceTarget{meeting: true, id: mt.ID})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"meeting": updated})
	return nil
}

// CancelMeeting cancels a meeting (its organizer). It stays listed as canceled; nobody
// may join any more, everyone in the call is disconnected and invitees get the
// cancellation for their calendars.
func (s *Service) CancelMeeting(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, mt, err := s.organizedMeeting(r)
	if err != nil {
		return err
	}
	if mt.CanceledAt != nil {
		return errMeetingCanceled
	}
	if !s.meetingWrites.Allow(m.UserID.String()) {
		return httpx.ErrRateLimited
	}
	var invited []recipient
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE meetings SET canceled_at = now(), sequence = sequence + 1, updated_at = now()
			WHERE id = $1 AND org_id = $2 AND canceled_at IS NULL`, mt.ID, m.Org.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errMeetingCanceled
		}
		rows, err := tx.Query(ctx, `SELECT user_id FROM meeting_invitees WHERE meeting_id = $1`, mt.ID)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return err
		}
		if invited, err = loadRecipients(ctx, tx, ids); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "meeting.canceled")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "meeting", mt.ID.String()
		ev.Metadata = map[string]any{"meeting": mt.Title, "startsAt": mt.StartsAt.UTC().Format(time.RFC3339)}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	canceled, err := s.meetingByID(ctx, m, mt.ID)
	if err != nil {
		return err
	}
	s.mailMeeting(ctx, m, canceled, invited, mail.MeetingCanceled)
	s.publishMeeting(m.Org.ID, canceled, nil)
	s.enforceVoiceLater(voiceTarget{meeting: true, id: mt.ID})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"meeting": canceled})
	return nil
}

// publishMeeting tells the organizer, the invitees and anyone just taken off the list
// that the meeting changed.
func (s *Service) publishMeeting(orgID uuid.UUID, mt *Meeting, also []uuid.UUID) {
	s.events.Publish(append(mt.people(), also...), realtime.Event{Type: "meeting.updated", Data: map[string]any{
		"orgId": orgID, "meetingId": mt.ID,
	}})
}

// recipient is someone who receives a meeting's emails: an active account, written to
// in its own language.
type recipient struct {
	email, name, locale string
}

func loadRecipients(ctx context.Context, q database.Querier, ids []uuid.UUID) ([]recipient, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx, `SELECT email, display_name, locale FROM users WHERE id = ANY ($1) AND disabled_at IS NULL`, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (recipient, error) {
		var r recipient
		err := row.Scan(&r.email, &r.name, &r.locale)
		return r, err
	})
}

// mailMeeting queues compose's email for each recipient, in the recipient's language
// (the request's when the account names none). Every change that sends meeting email
// is the organizer's, so the caller is the organizer.
func (s *Service) mailMeeting(ctx context.Context, m *org.Membership, mt *Meeting, to []recipient,
	compose func(l i18n.Locale, to, name string, mt mail.Meeting, now time.Time) mail.Message) {
	if s.outbox == nil || len(to) == 0 {
		return
	}
	organizer := identity(ctx).User
	zone, err := time.LoadLocation(mt.TimeZone)
	if err != nil {
		zone = time.UTC
	}
	link := s.publicURL + "/w/" + m.Org.Slug + "/m/" + mt.ID.String()
	details := mail.Meeting{
		UID: mt.ID.String() + "@" + publicHost(s.publicURL), Sequence: mt.sequence,
		Title: mt.Title, Agenda: mt.Agenda, Start: mt.StartsAt, End: mt.EndsAt, TimeZone: zone,
		Organizer: organizer.DisplayName, OrganizerEmail: organizer.Email, Link: link,
	}
	requestLocale := i18n.FromContext(ctx)
	now := time.Now()
	for _, rc := range to {
		l := requestLocale
		if own, ok := i18n.Parse(rc.locale); ok {
			l = own
		}
		msg := compose(l, rc.email, rc.name, details, now)
		s.outbox.Enqueue(func(context.Context) (*mail.Message, error) { return &msg, nil })
	}
}

// publicHost names this server in calendar UIDs, which must be globally unique.
func publicHost(publicURL string) string {
	if u, err := url.Parse(publicURL); err == nil && u.Hostname() != "" {
		return u.Hostname()
	}
	return "fudislte"
}
