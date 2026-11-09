package chat

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/media"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

// Voice and video in rooms and meetings (docs/architecture/phase-4.md, ADR-0011). Media
// flows through the self-hosted LiveKit server; the API decides who may connect. A
// room's token goes only to people admitted to the room and expires with their
// admission; a meeting's goes to its organizer and invitees while the meeting is open
// and expires when it closes. Anyone who may no longer be in a call is disconnected —
// at once by the action that ended their access, and by a sweep every 30 seconds for
// every other way access can end.

const maxVoiceToken = 6 * time.Hour

var (
	errMediaUnavailable = httpx.NewError(http.StatusServiceUnavailable, "media_unavailable", "Voice and video are not set up on this server.")
	errNotAdmitted      = httpx.NewError(http.StatusForbidden, "not_admitted", "Enter the room first.")
)

// publishSources are what participants may publish.
var publishSources = []string{"microphone", "camera", "screen_share", "screen_share_audio"}

// SetMedia connects the service to LiveKit; without it rooms and meetings have no voice.
func (s *Service) SetMedia(m *media.Service) { s.media = m }

// voiceTarget is what a FUDISLTE LiveKit room belongs to: a room ("fudislte-<roomID>") or a
// meeting ("fudislte-meeting-<meetingID>").
type voiceTarget struct {
	meeting bool
	id      uuid.UUID
}

func (v voiceTarget) room() string {
	if v.meeting {
		return media.MeetingRoomName(v.id)
	}
	return media.RoomName(v.id)
}

// parseVoiceRoom reads a LiveKit room name; other names are not FUDISLTE's.
func parseVoiceRoom(name string) (voiceTarget, bool) {
	if rest, ok := strings.CutPrefix(name, "fudislte-meeting-"); ok {
		id, err := uuid.Parse(rest)
		return voiceTarget{meeting: true, id: id}, err == nil && len(rest) == 36
	}
	if rest, ok := strings.CutPrefix(name, "fudislte-"); ok {
		id, err := uuid.Parse(rest)
		return voiceTarget{id: id}, err == nil && len(rest) == 36
	}
	return voiceTarget{}, false
}

type voiceTicket struct {
	URL       string    `json:"url"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// JoinVoice issues a LiveKit token for an admitted person.
func (s *Service) JoinVoice(w http.ResponseWriter, r *http.Request) error {
	m, rm, err := s.loadRoom(r)
	if err != nil {
		return err
	}
	if !s.media.Enabled() {
		return errMediaUnavailable
	}
	if !rm.Admitted {
		return errNotAdmitted
	}
	expires := time.Now().Add(maxVoiceToken)
	if rm.AdmissionExpiresAt != nil && rm.AdmissionExpiresAt.Before(expires) {
		expires = *rm.AdmissionExpiresAt
	}
	return s.writeTicket(w, r, m, media.RoomName(rm.ID), expires)
}

// JoinMeetingVoice issues a LiveKit token to the organizer or an invitee while the
// meeting is open; it expires when the join window closes. Outside the window, or
// once the meeting is canceled, the answer is 409 with the reason as its code.
func (s *Service) JoinMeetingVoice(w http.ResponseWriter, r *http.Request) error {
	m, mt, err := s.loadMeeting(r)
	if err != nil {
		return err
	}
	if !s.media.Enabled() {
		return errMediaUnavailable
	}
	if err := mt.joinable(time.Now()); err != nil {
		return err
	}
	return s.writeTicket(w, r, m, media.MeetingRoomName(mt.ID), mt.ClosesAt)
}

func (s *Service) writeTicket(w http.ResponseWriter, r *http.Request, m *org.Membership, room string, expires time.Time) error {
	id := identity(r.Context())
	token, err := s.media.Token(m.UserID.String(), id.User.DisplayName, media.Grant{
		Room: room, CanPublish: true, Sources: publishSources,
	}, expires)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"voice": voiceTicket{URL: s.media.URL(), Token: token, ExpiresAt: expires}})
	return nil
}

// VoiceParticipant is someone connected to a room's or a meeting's voice.
type VoiceParticipant struct {
	UserID      uuid.UUID `json:"userId"`
	DisplayName string    `json:"displayName"`
	Muted       bool      `json:"muted"`
	Camera      bool      `json:"camera"`
	ScreenShare bool      `json:"screenShare"`
}

func voiceParticipants(list []media.Participant) []VoiceParticipant {
	out := []VoiceParticipant{}
	for _, p := range list {
		id, err := uuid.Parse(p.Identity)
		if err != nil {
			continue
		}
		vp := VoiceParticipant{UserID: id, DisplayName: p.Name, Muted: true}
		for _, t := range p.Tracks {
			switch strings.ToLower(t.Source) {
			case "microphone":
				vp.Muted = t.Muted
			case "camera":
				vp.Camera = !t.Muted
			case "screen_share":
				vp.ScreenShare = !t.Muted
			}
		}
		out = append(out, vp)
	}
	slices.SortFunc(out, func(a, b VoiceParticipant) int {
		return strings.Compare(strings.ToLower(a.DisplayName), strings.ToLower(b.DisplayName))
	})
	return out
}

// VoiceState lists who is in a room's voice, for admitted people and room managers.
func (s *Service) VoiceState(w http.ResponseWriter, r *http.Request) error {
	_, rm, err := s.loadRoom(r)
	if err != nil {
		return err
	}
	if !rm.Admitted && !rm.CanManage {
		return httpx.ErrForbidden
	}
	return s.writeVoiceState(w, r, media.RoomName(rm.ID))
}

// MeetingVoiceState lists who is in a meeting's call, for its organizer and invitees.
func (s *Service) MeetingVoiceState(w http.ResponseWriter, r *http.Request) error {
	_, mt, err := s.loadMeeting(r)
	if err != nil {
		return err
	}
	return s.writeVoiceState(w, r, media.MeetingRoomName(mt.ID))
}

func (s *Service) writeVoiceState(w http.ResponseWriter, r *http.Request, room string) error {
	participants := []VoiceParticipant{}
	if s.media.Enabled() {
		list, err := s.media.Participants(r.Context(), room)
		if err != nil {
			return err
		}
		participants = voiceParticipants(list)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"enabled": s.media.Enabled(), "participants": participants})
	return nil
}

// MuteInVoice mutes someone's microphone (room managers).
func (s *Service) MuteInVoice(w http.ResponseWriter, r *http.Request) error {
	return s.moderateRoomVoice(w, r, false)
}

// RemoveFromVoice disconnects someone from the room's voice (room managers). Their
// admission stays; end it, or change the password, to keep them out.
func (s *Service) RemoveFromVoice(w http.ResponseWriter, r *http.Request) error {
	return s.moderateRoomVoice(w, r, true)
}

func (s *Service) moderateRoomVoice(w http.ResponseWriter, r *http.Request, remove bool) error {
	m, rm, err := s.managedRoom(r)
	if err != nil {
		return err
	}
	return s.moderate(w, r, m, media.RoomName(rm.ID), "room", remove, map[string]any{"room": rm.Name})
}

// MuteInMeeting mutes someone's microphone in a meeting (its organizer).
func (s *Service) MuteInMeeting(w http.ResponseWriter, r *http.Request) error {
	return s.moderateMeetingVoice(w, r, false)
}

// RemoveFromMeeting disconnects someone from a meeting's call (its organizer). They are
// still invited and may join again; take them off the list to keep them out.
func (s *Service) RemoveFromMeeting(w http.ResponseWriter, r *http.Request) error {
	return s.moderateMeetingVoice(w, r, true)
}

func (s *Service) moderateMeetingVoice(w http.ResponseWriter, r *http.Request, remove bool) error {
	m, mt, err := s.organizedMeeting(r)
	if err != nil {
		return err
	}
	return s.moderate(w, r, m, media.MeetingRoomName(mt.ID), "meeting", remove, map[string]any{"meeting": mt.Title})
}

// moderate mutes the microphone of {userID} in a LiveKit room, or disconnects them, and
// records it as <kind>.voice_muted or <kind>.voice_removed with meta.
func (s *Service) moderate(w http.ResponseWriter, r *http.Request, m *org.Membership, room, kind string, remove bool, meta map[string]any) error {
	ctx := r.Context()
	if !s.media.Enabled() {
		return errMediaUnavailable
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	list, err := s.media.Participants(ctx, room)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(list, func(p media.Participant) bool { return p.Identity == userID.String() })
	if i < 0 {
		return httpx.ErrNotFound
	}
	action := kind + ".voice_removed"
	if remove {
		err = s.media.RemoveParticipant(ctx, room, userID.String())
	} else {
		action = kind + ".voice_muted"
		for _, t := range list[i].Tracks {
			if strings.EqualFold(t.Source, "microphone") && !t.Muted {
				if err = s.media.MuteTrack(ctx, room, userID.String(), t.SID); err != nil {
					break
				}
			}
		}
	}
	if err != nil {
		return err
	}
	ev := audit.FromRequest(r, action)
	ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
	ev.TargetType, ev.TargetID = "user", userID.String()
	ev.Metadata = meta
	if err := audit.Record(ctx, s.db, ev); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// disconnectVoice removes people whose admission just ended from the room's voice. It
// runs in the background: the change that ended the admission is already committed.
func (s *Service) disconnectVoice(roomID uuid.UUID, users []uuid.UUID) {
	if !s.media.Enabled() || len(users) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		for _, u := range users {
			if err := s.media.RemoveParticipant(ctx, media.RoomName(roomID), u.String()); err != nil {
				slog.Warn("chat: disconnect voice", "room", roomID, "user", u, "error", err)
			}
		}
	}()
}

// enforceVoiceLater disconnects, in the background, everyone in target's call who may
// no longer be there — after a change that is already committed, such as a canceled
// meeting or a shorter invitation list.
func (s *Service) enforceVoiceLater(target voiceTarget) {
	if !s.media.Enabled() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.enforceVoice(ctx, target); err != nil {
			slog.Warn("chat: enforce voice", "room", target.room(), "error", err)
		}
	}()
}

// sweepVoice disconnects everyone in a FUDISLTE LiveKit room who may no longer be there:
// expired admissions, removed or disabled accounts, deleted rooms, canceled meetings,
// people no longer invited and meetings whose join window has closed.
func (s *Service) sweepVoice(ctx context.Context) error {
	if !s.media.Enabled() {
		return nil
	}
	rooms, err := s.media.Rooms(ctx)
	if err != nil {
		return err
	}
	for _, name := range rooms {
		if target, ok := parseVoiceRoom(name); ok {
			if err := s.enforceVoice(ctx, target); err != nil {
				return err
			}
		}
	}
	return nil
}

// enforceVoice disconnects everyone in target's LiveKit room who may not be there.
func (s *Service) enforceVoice(ctx context.Context, target voiceTarget) error {
	list, err := s.media.Participants(ctx, target.room())
	if err != nil || len(list) == 0 {
		return err
	}
	allowed, err := s.voiceAllowed(ctx, target)
	if err != nil {
		return err
	}
	for _, p := range list {
		id, err := uuid.Parse(p.Identity)
		if err == nil && allowed[id] {
			continue
		}
		if err := s.media.RemoveParticipant(ctx, target.room(), p.Identity); err != nil {
			return err
		}
	}
	return nil
}

// voiceAllowed returns who may be in target's call: for a room, admitted people with
// active accounts; for a meeting, its organizer and invitees with active accounts while
// it is open and not canceled.
func (s *Service) voiceAllowed(ctx context.Context, target voiceTarget) (map[uuid.UUID]bool, error) {
	query := `
		SELECT cm.user_id FROM channel_members cm
		JOIN channels c ON c.id = cm.channel_id AND c.kind = 'room'
		JOIN users u ON u.id = cm.user_id AND u.disabled_at IS NULL
		WHERE cm.channel_id = $1 AND (cm.expires_at IS NULL OR cm.expires_at > now())`
	if target.meeting {
		var mt Meeting
		err := s.db.QueryRow(ctx, `SELECT starts_at, duration_minutes, canceled_at FROM meetings WHERE id = $1`, target.id).
			Scan(&mt.StartsAt, &mt.DurationMinutes, &mt.CanceledAt)
		if isNoRows(err) {
			return map[uuid.UUID]bool{}, nil
		}
		if err != nil {
			return nil, err
		}
		mt.settle(uuid.Nil)
		if mt.joinable(time.Now()) != nil {
			return map[uuid.UUID]bool{}, nil
		}
		query = `
			SELECT u.id FROM users u
			WHERE u.disabled_at IS NULL AND u.id IN (
			    SELECT organizer_id FROM meetings WHERE id = $1
			    UNION SELECT user_id FROM meeting_invitees WHERE meeting_id = $1)`
	}
	rows, err := s.db.Query(ctx, query, target.id)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	allowed := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		allowed[id] = true
	}
	return allowed, nil
}

// MediaWebhook receives LiveKit's notifications. Participant changes are relayed to the
// people of the room or meeting as voice.updated; someone connected without the right
// to be there is removed.
func (s *Service) MediaWebhook(w http.ResponseWriter, r *http.Request) error {
	if !s.media.Enabled() {
		return httpx.ErrNotFound
	}
	ev, err := s.media.ParseWebhook(r)
	if err != nil {
		return httpx.ErrUnauthorized
	}
	if ev.Room == nil {
		httpx.NoContent(w)
		return nil
	}
	target, ok := parseVoiceRoom(ev.Room.Name)
	if !ok {
		httpx.NoContent(w)
		return nil
	}
	ctx := r.Context()
	if ev.Event == "participant_joined" && ev.Participant != nil {
		allowed, err := s.voiceAllowed(ctx, target)
		if err != nil {
			return err
		}
		if id, err := uuid.Parse(ev.Participant.Identity); err != nil || !allowed[id] {
			if err := s.media.RemoveParticipant(ctx, ev.Room.Name, ev.Participant.Identity); err != nil {
				return err
			}
		}
	}
	if strings.HasPrefix(ev.Event, "participant_") || strings.HasPrefix(ev.Event, "track_") || ev.Event == "room_finished" {
		s.publishVoice(ctx, target)
	}
	httpx.NoContent(w)
	return nil
}

// publishVoice tells the people of a room (its members) or a meeting (its organizer and
// invitees) who is in its call now. voice.updated carries roomId or meetingId.
func (s *Service) publishVoice(ctx context.Context, target voiceTarget) {
	var (
		orgID uuid.UUID
		to    []uuid.UUID
		key   = "roomId"
	)
	if target.meeting {
		key = "meetingId"
		err := s.db.QueryRow(ctx, `
			SELECT org_id, array_remove(array_append(ARRAY(SELECT user_id FROM meeting_invitees WHERE meeting_id = $1), organizer_id), NULL)
			FROM meetings WHERE id = $1`, target.id).Scan(&orgID, &to)
		if err != nil {
			return
		}
	} else {
		if err := s.db.QueryRow(ctx, `SELECT org_id FROM channels WHERE id = $1 AND kind = 'room'`, target.id).Scan(&orgID); err != nil {
			return
		}
		ids, err := memberIDs(ctx, s.db, target.id)
		if err != nil {
			return
		}
		to = ids
	}
	list, err := s.media.Participants(ctx, target.room())
	if err != nil {
		return
	}
	s.events.Publish(to, realtime.Event{Type: "voice.updated", Data: map[string]any{
		"orgId": orgID, key: target.id, "participants": voiceParticipants(list),
	}})
}
