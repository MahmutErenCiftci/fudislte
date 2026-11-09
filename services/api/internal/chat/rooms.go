package chat

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/passwords"
	"fudislte/api/internal/realtime"
)

// Secure rooms (docs/architecture/phase-3.md, ADR-0010) are channels of kind 'room':
// being in channel_members is being admitted, so messages, files, search and live events
// follow admission. A password is checked only for people already allowed to enter;
// it never replaces authorization.

const (
	AccessOpen       = "open"
	AccessProtected  = "protected"
	AccessRestricted = "restricted"

	defaultAdmissionMinutes = 12 * 60
	minAdmissionMinutes     = 15
	maxAdmissionMinutes     = 30 * 24 * 60
	maxAccessList           = 500
)

var (
	errRoomManaged   = httpx.NewError(http.StatusConflict, "room_managed", "Manage this room from its settings.")
	errRoomNameTaken = httpx.NewError(http.StatusConflict, "room_name_taken", "A room with this name already exists.")
	errWrongPassword = httpx.NewError(http.StatusForbidden, "wrong_password", "The password is not correct.")
	errNotAllowed    = httpx.NewError(http.StatusForbidden, "room_not_allowed", "You are not on this room's access list.")
	errNotRestricted = httpx.NewError(http.StatusConflict, "room_not_restricted", "Only restricted rooms have an access list.")
)

// Room is what a person sees of a room; the caller's admission included.
type Room struct {
	ID                uuid.UUID  `json:"id"`
	Name              string     `json:"name"`
	Topic             string     `json:"topic"`
	Access            string     `json:"access"`
	HasPassword       bool       `json:"hasPassword"`
	AdmissionMinutes  int        `json:"admissionMinutes"`
	PasswordChangedAt *time.Time `json:"passwordChangedAt"`
	CreatedBy         *uuid.UUID `json:"createdBy"`
	CreatedAt         time.Time  `json:"createdAt"`
	// MemberCount is how many people are admitted now.
	MemberCount int `json:"memberCount"`
	// Admitted and AdmissionExpiresAt describe the caller; a nil expiry lasts.
	Admitted           bool       `json:"admitted"`
	AdmissionExpiresAt *time.Time `json:"admissionExpiresAt"`
	// Allowed is set when the caller is on a restricted room's access list.
	Allowed       bool       `json:"allowed"`
	CanEnter      bool       `json:"canEnter"`
	NeedsPassword bool       `json:"needsPassword"`
	CanManage     bool       `json:"canManage"`
	UnreadCount   int        `json:"unreadCount"`
	LastReadID    *uuid.UUID `json:"lastReadId"`
}

const roomQuery = `
	SELECT c.id, c.name, c.topic, c.access, c.password_hash IS NOT NULL, c.admission_minutes, c.password_changed_at,
	       c.created_by, c.created_at,
	       (SELECT count(*) FROM channel_members x WHERE x.channel_id = c.id AND (x.expires_at IS NULL OR x.expires_at > now())),
	       cm.user_id IS NOT NULL, cm.expires_at, cm.last_read_id,
	       EXISTS (SELECT 1 FROM room_access ra WHERE ra.channel_id = c.id AND ra.user_id = $2),
	       CASE WHEN cm.user_id IS NULL THEN 0 ELSE (
	           SELECT count(*) FROM (
	               SELECT 1 FROM messages msg
	               WHERE msg.channel_id = c.id AND msg.parent_id IS NULL AND msg.deleted_at IS NULL
	                 AND (cm.last_read_id IS NULL OR msg.id > cm.last_read_id)
	                 AND msg.author_id IS DISTINCT FROM $2
	               LIMIT 100) unread) END
	FROM channels c
	LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2 AND (cm.expires_at IS NULL OR cm.expires_at > now())
	WHERE c.org_id = $1 AND c.kind = 'room'`

func queryRooms(ctx context.Context, q database.Querier, m *org.Membership, filter string, args ...any) ([]Room, error) {
	rows, err := q.Query(ctx, roomQuery+filter, append([]any{m.Org.ID, m.UserID}, args...)...)
	if err != nil {
		return nil, err
	}
	rooms, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Room, error) {
		var rm Room
		err := row.Scan(&rm.ID, &rm.Name, &rm.Topic, &rm.Access, &rm.HasPassword, &rm.AdmissionMinutes, &rm.PasswordChangedAt,
			&rm.CreatedBy, &rm.CreatedAt, &rm.MemberCount, &rm.Admitted, &rm.AdmissionExpiresAt, &rm.LastReadID, &rm.Allowed, &rm.UnreadCount)
		return rm, err
	})
	if err != nil {
		return nil, err
	}
	for i := range rooms {
		rooms[i].settle(m)
	}
	return rooms, nil
}

func (rm *Room) isCreator(m *org.Membership) bool {
	return rm.CreatedBy != nil && *rm.CreatedBy == m.UserID
}

// settle works out what the caller may do. Open and protected rooms are for people who
// may enter rooms; restricted ones for their access list only. Creators always enter
// without the password they set; room managers change settings but are admitted like
// everyone else.
func (rm *Room) settle(m *org.Membership) {
	creator := rm.isCreator(m)
	rm.CanManage = creator || m.Can(org.PermRoomsManage)
	switch {
	case rm.Admitted || creator:
		rm.CanEnter = true
	case rm.Access == AccessRestricted:
		rm.CanEnter = rm.Allowed
	default:
		rm.CanEnter = m.Can(org.PermRoomsJoin)
	}
	rm.NeedsPassword = rm.HasPassword && !creator && !rm.Admitted
}

func (rm *Room) visible() bool { return rm.CanEnter || rm.CanManage }

// loadRoom returns the {roomID} room if the caller may see it; httpx.ErrNotFound
// otherwise, so a restricted room's existence is not disclosed.
func (s *Service) loadRoom(r *http.Request) (*org.Membership, *Room, error) {
	m := org.MembershipFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "roomID"))
	if err != nil {
		return m, nil, httpx.ErrNotFound
	}
	rooms, err := queryRooms(r.Context(), s.db, m, ` AND c.id = $3`, id)
	if err != nil {
		return m, nil, err
	}
	if len(rooms) == 0 || !rooms[0].visible() {
		return m, nil, httpx.ErrNotFound
	}
	return m, &rooms[0], nil
}

func (s *Service) managedRoom(r *http.Request) (*org.Membership, *Room, error) {
	m, rm, err := s.loadRoom(r)
	if err == nil && !rm.CanManage {
		err = httpx.ErrForbidden
	}
	return m, rm, err
}

// ListRooms returns the rooms the caller can enter. With ?all=true, room managers
// (rooms.manage) get every room of the workspace — settings only, never contents.
func (s *Service) ListRooms(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	all := r.URL.Query().Get("all") == "true"
	if all && !m.Can(org.PermRoomsManage) {
		return httpx.ErrForbidden
	}
	rooms, err := queryRooms(r.Context(), s.db, m, ` ORDER BY lower(c.name), c.id`)
	if err != nil {
		return err
	}
	if !all {
		rooms = slices.DeleteFunc(rooms, func(rm Room) bool { return !rm.CanEnter })
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"rooms": rooms})
	return nil
}

func (s *Service) GetRoom(w http.ResponseWriter, r *http.Request) error {
	_, rm, err := s.loadRoom(r)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"room": rm})
	return nil
}

func normalizeRoomName(s string) (string, string) {
	s = strings.Join(strings.Fields(s), " ")
	if n := utf8.RuneCountInString(s); n < 1 || n > 60 || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", "Use 1 to 60 characters."
	}
	return s, ""
}

func validAdmission(minutes int) bool {
	return minutes >= minAdmissionMinutes && minutes <= maxAdmissionMinutes
}

// workspaceMembers fails unless every ID belongs to a member of the workspace.
func workspaceMembers(ctx context.Context, q database.Querier, orgID uuid.UUID, ids []uuid.UUID) error {
	var known int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = ANY ($2)`, orgID, ids).Scan(&known); err != nil {
		return err
	}
	if known != len(ids) {
		return httpx.Invalid(map[string]string{"memberIds": "Choose members of this workspace."})
	}
	return nil
}

func (s *Service) CreateRoom(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	var in struct {
		Name             string      `json:"name"`
		Topic            string      `json:"topic"`
		Access           string      `json:"access"`
		Password         string      `json:"password"`
		AdmissionMinutes *int        `json:"admissionMinutes"`
		MemberIDs        []uuid.UUID `json:"memberIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	fields := map[string]string{}
	name, msg := normalizeRoomName(in.Name)
	if msg != "" {
		fields["name"] = msg
	}
	topic, msg := normalizeTopic(in.Topic)
	if msg != "" {
		fields["topic"] = msg
	}
	switch in.Access {
	case AccessOpen:
		if in.Password != "" {
			fields["password"] = "Open rooms have no password."
		}
	case AccessProtected:
		if msg := passwords.Check(in.Password); msg != "" {
			fields["password"] = msg
		}
	case AccessRestricted:
		if in.Password != "" {
			if msg := passwords.Check(in.Password); msg != "" {
				fields["password"] = msg
			}
		}
	default:
		fields["access"] = "Choose open, password-protected or restricted."
	}
	admission := defaultAdmissionMinutes
	if in.AdmissionMinutes != nil {
		admission = *in.AdmissionMinutes
	}
	if !validAdmission(admission) {
		fields["admissionMinutes"] = "Choose between 15 minutes and 30 days."
	}
	if len(in.MemberIDs) > maxAccessList {
		fields["memberIds"] = "Add at most 500 people."
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}

	var hash *string
	if in.Password != "" {
		h, err := passwords.Hash(in.Password)
		if err != nil {
			return err
		}
		hash = &h
	}
	id := uuid.Must(uuid.NewV7())
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO channels (id, org_id, kind, name, topic, visibility, created_by, access, password_hash, password_changed_at, admission_minutes)
			VALUES ($1, $2, 'room', $3, $4, 'private', $5, $6, $7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END, $8)`,
			id, m.Org.ID, name, topic, m.UserID, in.Access, hash, admission)
		if database.IsUniqueViolation(err, "channels_room_name_key") {
			return errRoomNameTaken
		}
		if err != nil {
			return err
		}
		if _, err := addMembers(ctx, tx, m.Org.ID, id, []uuid.UUID{m.UserID}); err != nil {
			return err
		}
		if in.Access == AccessRestricted {
			list := unique(append([]uuid.UUID{m.UserID}, in.MemberIDs...))
			if err := workspaceMembers(ctx, tx, m.Org.ID, list); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO room_access (channel_id, org_id, user_id, added_by)
				SELECT $1, $2, u, $3 FROM unnest($4::uuid[]) AS u`, id, m.Org.ID, m.UserID, list); err != nil {
				return err
			}
		}
		ev := audit.FromRequest(r, "room.created")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "room", id.String()
		ev.Metadata = map[string]any{"name": name, "access": in.Access, "password": hash != nil}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	rooms, err := queryRooms(ctx, s.db, m, ` AND c.id = $3`, id)
	if err != nil || len(rooms) == 0 {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"room": rooms[0]})
	return nil
}

// UpdateRoom renames a room, changes its description or how long a password admission
// lasts. A shorter admission also shortens the ones already granted.
func (s *Service) UpdateRoom(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, rm, err := s.managedRoom(r)
	if err != nil {
		return err
	}
	var in struct {
		Name             *string `json:"name"`
		Topic            *string `json:"topic"`
		AdmissionMinutes *int    `json:"admissionMinutes"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	name, topic, admission := rm.Name, rm.Topic, rm.AdmissionMinutes
	fields := map[string]string{}
	if in.Name != nil {
		var msg string
		if name, msg = normalizeRoomName(*in.Name); msg != "" {
			fields["name"] = msg
		}
	}
	if in.Topic != nil {
		var msg string
		if topic, msg = normalizeTopic(*in.Topic); msg != "" {
			fields["topic"] = msg
		}
	}
	if in.AdmissionMinutes != nil {
		if admission = *in.AdmissionMinutes; !validAdmission(admission) {
			fields["admissionMinutes"] = "Choose between 15 minutes and 30 days."
		}
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE channels SET name = $3, topic = $4, admission_minutes = $5 WHERE id = $1 AND org_id = $2`,
			rm.ID, m.Org.ID, name, topic, admission)
		if database.IsUniqueViolation(err, "channels_room_name_key") {
			return errRoomNameTaken
		}
		if err != nil {
			return err
		}
		if admission < rm.AdmissionMinutes {
			if _, err := tx.Exec(ctx, `
				UPDATE channel_members SET expires_at = least(expires_at, now() + make_interval(mins => $2))
				WHERE channel_id = $1 AND expires_at IS NOT NULL`, rm.ID, admission); err != nil {
				return err
			}
		}
		changes := map[string]any{}
		if name != rm.Name {
			changes["name"] = map[string]string{"from": rm.Name, "to": name}
		}
		if admission != rm.AdmissionMinutes {
			changes["admissionMinutes"] = map[string]int{"from": rm.AdmissionMinutes, "to": admission}
		}
		if len(changes) == 0 {
			return nil
		}
		changes["room"] = name
		ev := audit.FromRequest(r, "room.updated")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "room", rm.ID.String()
		ev.Metadata = changes
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	return s.respondRoom(w, r, m, rm.ID)
}

func (s *Service) respondRoom(w http.ResponseWriter, r *http.Request, m *org.Membership, id uuid.UUID) error {
	s.publishToMembers(r.Context(), id, realtime.Event{Type: "room.updated", Data: map[string]any{"orgId": m.Org.ID, "roomId": id}})
	rooms, err := queryRooms(r.Context(), s.db, m, ` AND c.id = $3`, id)
	if err != nil {
		return err
	}
	if len(rooms) == 0 {
		return httpx.ErrNotFound
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"room": rooms[0]})
	return nil
}

// endAdmissions removes people from the room inside tx — everyone, or only those listed —
// and returns who left. The creator stays: they enter without a password anyway.
func endAdmissions(ctx context.Context, tx pgx.Tx, rm *Room, only []uuid.UUID) ([]uuid.UUID, error) {
	query := `DELETE FROM channel_members WHERE channel_id = $1 AND user_id IS DISTINCT FROM $2`
	args := []any{rm.ID, rm.CreatedBy}
	if only != nil {
		query += ` AND user_id = ANY ($3)`
		args = append(args, only)
	}
	rows, err := tx.Query(ctx, query+` RETURNING user_id`, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// announceLeft tells people they are out of the room and the rest its new size.
func (s *Service) announceLeft(ctx context.Context, orgID, roomID uuid.UUID, ended []uuid.UUID) {
	if len(ended) == 0 {
		return
	}
	s.events.Publish(ended, realtime.Event{Type: "channel.left", Data: channelEvent{orgID, roomID}})
	s.publishMembership(ctx, orgID, roomID)
	s.disconnectVoice(roomID, ended)
}

// SetRoomSecurity changes a room's access mode or password. Any change ends every
// admission but the creator's: people enter again under the new rules.
func (s *Service) SetRoomSecurity(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, rm, err := s.managedRoom(r)
	if err != nil {
		return err
	}
	var in struct {
		Access         string `json:"access"`
		Password       string `json:"password"`
		RemovePassword bool   `json:"removePassword"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	fields := map[string]string{}
	if in.Password != "" {
		if msg := passwords.Check(in.Password); msg != "" {
			fields["password"] = msg
		}
	}
	keep := in.Password == "" && !in.RemovePassword
	hasPassword := in.Password != "" || (keep && rm.HasPassword)
	switch in.Access {
	case AccessOpen:
		if in.Password != "" {
			fields["password"] = "Open rooms have no password."
		}
		hasPassword = false
	case AccessProtected:
		if !hasPassword {
			fields["password"] = "Set a password."
		}
	case AccessRestricted:
	default:
		fields["access"] = "Choose open, password-protected or restricted."
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	passwordChanged := in.Password != "" || (rm.HasPassword && !hasPassword)
	if in.Access == rm.Access && !passwordChanged {
		return s.respondRoom(w, r, m, rm.ID)
	}
	var hash *string
	if in.Password != "" {
		h, err := passwords.Hash(in.Password)
		if err != nil {
			return err
		}
		hash = &h
	}

	var ended []uuid.UUID
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE channels SET access = $3,
			       password_hash = CASE WHEN $4 THEN password_hash ELSE $5 END,
			       password_changed_at = CASE WHEN $6 THEN now() ELSE password_changed_at END
			WHERE id = $1 AND org_id = $2`,
			rm.ID, m.Org.ID, in.Access, hasPassword && keep, hash, passwordChanged)
		if err != nil {
			return err
		}
		if in.Access == AccessRestricted && rm.Access != AccessRestricted && rm.CreatedBy != nil {
			// A room becoming restricted starts with its creator on the list.
			if _, err := tx.Exec(ctx, `
				INSERT INTO room_access (channel_id, org_id, user_id, added_by) VALUES ($1, $2, $3, $4)
				ON CONFLICT DO NOTHING`, rm.ID, m.Org.ID, *rm.CreatedBy, m.UserID); err != nil {
				return err
			}
		}
		if ended, err = endAdmissions(ctx, tx, rm, nil); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "room.security_changed")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "room", rm.ID.String()
		ev.Metadata = map[string]any{
			"room": rm.Name, "access": map[string]string{"from": rm.Access, "to": in.Access},
			"passwordChanged": passwordChanged, "admissionsEnded": len(ended),
		}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.announceLeft(ctx, m.Org.ID, rm.ID, ended)
	return s.respondRoom(w, r, m, rm.ID)
}

type roomPerson struct {
	User struct {
		ID          uuid.UUID `json:"id"`
		DisplayName string    `json:"displayName"`
	} `json:"user"`
	Since     time.Time  `json:"since"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

func collectPeople(rows pgx.Rows) ([]roomPerson, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (roomPerson, error) {
		var p roomPerson
		err := row.Scan(&p.User.ID, &p.User.DisplayName, &p.Since, &p.ExpiresAt)
		return p, err
	})
}

// RoomAccess lists a restricted room's access list for its managers.
func (s *Service) RoomAccess(w http.ResponseWriter, r *http.Request) error {
	_, rm, err := s.managedRoom(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT u.id, u.display_name, ra.added_at, NULL::timestamptz
		FROM room_access ra JOIN users u ON u.id = ra.user_id
		WHERE ra.channel_id = $1 ORDER BY lower(u.display_name), u.id`, rm.ID)
	if err != nil {
		return err
	}
	people, err := collectPeople(rows)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"people": people})
	return nil
}

// SetRoomAccess replaces a restricted room's access list. People taken off it leave the
// room at once.
func (s *Service) SetRoomAccess(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, rm, err := s.managedRoom(r)
	if err != nil {
		return err
	}
	if rm.Access != AccessRestricted {
		return errNotRestricted
	}
	var in struct {
		UserIDs []uuid.UUID `json:"userIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	list := unique(in.UserIDs)
	if rm.CreatedBy != nil && !slices.Contains(list, *rm.CreatedBy) {
		list = append(list, *rm.CreatedBy) // the creator always stays on the list
	}
	if len(list) > maxAccessList {
		return httpx.Invalid(map[string]string{"userIds": "Add at most 500 people."})
	}
	var ended []uuid.UUID
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := workspaceMembers(ctx, tx, m.Org.ID, list); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `DELETE FROM room_access WHERE channel_id = $1 AND NOT (user_id = ANY ($2)) RETURNING user_id`, rm.ID, list)
		if err != nil {
			return err
		}
		removed, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return err
		}
		rows, err = tx.Query(ctx, `
			INSERT INTO room_access (channel_id, org_id, user_id, added_by)
			SELECT $1, $2, u, $3 FROM unnest($4::uuid[]) AS u
			ON CONFLICT DO NOTHING RETURNING user_id`, rm.ID, m.Org.ID, m.UserID, list)
		if err != nil {
			return err
		}
		added, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return err
		}
		if len(removed) > 0 {
			if ended, err = endAdmissions(ctx, tx, rm, removed); err != nil {
				return err
			}
		}
		if len(added) == 0 && len(removed) == 0 {
			return nil
		}
		ev := audit.FromRequest(r, "room.access_changed")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "room", rm.ID.String()
		ev.Metadata = map[string]any{"room": rm.Name, "added": added, "removed": removed}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.announceLeft(ctx, m.Org.ID, rm.ID, ended)
	return s.RoomAccess(w, r)
}

// EnterRoom admits the caller. People who may not enter get 404 (or 403 for managers
// who may only see the room); a password is checked only after that, with a per-person
// attempt limit, and its admission expires.
func (s *Service) EnterRoom(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, rm, err := s.loadRoom(r)
	if err != nil {
		return err
	}
	if !rm.CanEnter {
		return errNotAllowed
	}
	var in struct {
		Password string `json:"password"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if rm.Admitted && (rm.AdmissionExpiresAt == nil || in.Password == "") {
		return s.respondRoom(w, r, m, rm.ID)
	}
	// Being admitted again with the password renews an expiring admission.
	needsPassword := rm.HasPassword && !rm.isCreator(m)
	var expires *time.Time
	if needsPassword {
		if !s.roomAttempts.Allow(m.UserID.String() + "/" + rm.ID.String()) {
			return httpx.ErrRateLimited
		}
		var hash string
		if err := s.db.QueryRow(ctx, `SELECT password_hash FROM channels WHERE id = $1`, rm.ID).Scan(&hash); err != nil {
			return err
		}
		ok, err := passwords.Verify(hash, in.Password)
		if err != nil {
			return err
		}
		if !ok {
			ev := audit.FromRequest(r, "room.password_failed")
			ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
			ev.TargetType, ev.TargetID = "room", rm.ID.String()
			ev.Metadata = map[string]any{"room": rm.Name}
			if err := audit.Record(ctx, s.db, ev); err != nil {
				return err
			}
			return errWrongPassword
		}
		t := time.Now().Add(time.Duration(rm.AdmissionMinutes) * time.Minute)
		expires = &t
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO channel_members (channel_id, org_id, user_id, last_read_id, expires_at)
			VALUES ($1, $2, $3, (SELECT id FROM messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 1), $4)
			ON CONFLICT (channel_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at,
			    joined_at = CASE WHEN channel_members.expires_at IS NOT NULL AND channel_members.expires_at <= now()
			                     THEN now() ELSE channel_members.joined_at END`,
			rm.ID, m.Org.ID, m.UserID, expires)
		if err != nil || rm.Access == AccessOpen {
			return err
		}
		ev := audit.FromRequest(r, "room.entered")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "room", rm.ID.String()
		ev.Metadata = map[string]any{"room": rm.Name, "password": needsPassword}
		if expires != nil {
			ev.Metadata["expiresAt"] = expires.UTC().Format(time.RFC3339)
		}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.events.Publish([]uuid.UUID{m.UserID}, realtime.Event{Type: "channel.joined", Data: channelEvent{m.Org.ID, rm.ID}})
	s.publishMembership(ctx, m.Org.ID, rm.ID)
	return s.respondRoom(w, r, m, rm.ID)
}

func (s *Service) LeaveRoom(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, rm, err := s.loadRoom(r)
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, rm.ID, m.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.announceLeft(ctx, m.Org.ID, rm.ID, []uuid.UUID{m.UserID})
	}
	httpx.NoContent(w)
	return nil
}

// RoomMembers lists who is in the room now, with when their admission ends. Admitted
// people and room managers see it.
func (s *Service) RoomMembers(w http.ResponseWriter, r *http.Request) error {
	_, rm, err := s.loadRoom(r)
	if err != nil {
		return err
	}
	if !rm.Admitted && !rm.CanManage {
		return httpx.ErrForbidden
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT u.id, u.display_name, cm.joined_at, cm.expires_at
		FROM channel_members cm JOIN users u ON u.id = cm.user_id
		WHERE cm.channel_id = $1 AND (cm.expires_at IS NULL OR cm.expires_at > now())
		ORDER BY lower(u.display_name), u.id`, rm.ID)
	if err != nil {
		return err
	}
	people, err := collectPeople(rows)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"people": people})
	return nil
}

// EndAdmission takes someone out of the room. They may enter again if they still may;
// change the password or the access list to keep them out.
func (s *Service) EndAdmission(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, rm, err := s.managedRoom(r)
	if err != nil {
		return err
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	var ended []uuid.UUID
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, rm.ID, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.ErrNotFound
		}
		ended = []uuid.UUID{userID}
		ev := audit.FromRequest(r, "room.admission_ended")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "user", userID.String()
		ev.Metadata = map[string]any{"room": rm.Name}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.announceLeft(ctx, m.Org.ID, rm.ID, ended)
	httpx.NoContent(w)
	return nil
}

// DeleteRoom removes a room with its messages and files.
func (s *Service) DeleteRoom(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, rm, err := s.managedRoom(r)
	if err != nil {
		return err
	}
	members, err := memberIDs(ctx, s.db, rm.ID)
	if err != nil {
		return err
	}
	var files []uuid.UUID
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `DELETE FROM attachments WHERE channel_id = $1 RETURNING id`, rm.ID)
		if err != nil {
			return err
		}
		if files, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID]); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM channels WHERE id = $1 AND org_id = $2 AND kind = 'room'`, rm.ID, m.Org.ID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "room.deleted")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "room", rm.ID.String()
		ev.Metadata = map[string]any{"room": rm.Name, "access": rm.Access}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.removeFiles(m.Org.ID, files)
	s.events.Publish(members, realtime.Event{Type: "channel.left", Data: channelEvent{m.Org.ID, rm.ID}})
	s.disconnectVoice(rm.ID, members)
	httpx.NoContent(w)
	return nil
}

// ExpireAdmissions ends password admissions as they run out, every interval, tells the
// people concerned and disconnects anyone in a room's or a meeting's call who may no
// longer be there. Queries already ignore expired admissions; this makes clients
// notice at once and keeps the table small.
func (s *Service) ExpireAdmissions(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := s.expireAdmissions(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("chat: expire room admissions", "error", err)
		}
		if err := s.sweepVoice(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("chat: sweep voice", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Service) expireAdmissions(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `DELETE FROM channel_members WHERE expires_at <= now() RETURNING org_id, channel_id, user_id`)
	if err != nil {
		return err
	}
	type key struct{ org, room uuid.UUID }
	ended := map[key][]uuid.UUID{}
	var orgID, roomID, userID uuid.UUID
	_, err = pgx.ForEachRow(rows, []any{&orgID, &roomID, &userID}, func() error {
		k := key{orgID, roomID}
		ended[k] = append(ended[k], userID)
		return nil
	})
	if err != nil {
		return err
	}
	for k, users := range ended {
		s.announceLeft(ctx, k.org, k.room, users)
	}
	return nil
}
