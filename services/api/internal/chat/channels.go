package chat

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

// channelEvent identifies the channel an event is about.
type channelEvent struct {
	OrgID     uuid.UUID `json:"orgId"`
	ChannelID uuid.UUID `json:"channelId"`
}

var (
	errLeaveDefault  = httpx.NewError(http.StatusConflict, "default_channel", "Everyone stays in the default channel.")
	errFixedMembers  = httpx.NewError(http.StatusConflict, "direct_conversation", "Direct conversations keep the people they started with.")
	errNameTaken     = httpx.Invalid(map[string]string{"name": "A channel with this name already exists."})
	errUnknownMember = httpx.Invalid(map[string]string{"userIds": "Choose members of this workspace."})
)

const maxMembersPerRequest = 200

// ListChannels returns the channels the caller has joined — the sidebar — default
// channel first.
func (s *Service) ListChannels(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	chans, err := queryChannels(r.Context(), s.db, m.Org.ID, m.UserID, ` AND c.kind = 'channel' AND c.archived_at IS NULL AND cm.user_id IS NOT NULL ORDER BY c.is_default DESC, c.name`)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"channels": chans})
	return nil
}

// BrowseChannels lists the workspace's public channels, joined or not, then the
// archived channels the caller may see.
func (s *Service) BrowseChannels(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	if !m.Can(org.PermChannelsJoin) {
		return httpx.ErrForbidden
	}
	chans, err := queryChannels(r.Context(), s.db, m.Org.ID, m.UserID, `
		AND c.kind = 'channel'
		AND (c.visibility = 'public' OR (c.archived_at IS NOT NULL AND cm.user_id IS NOT NULL))
		ORDER BY c.archived_at IS NOT NULL, c.name`)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"channels": chans})
	return nil
}

func (s *Service) GetChannel(w http.ResponseWriter, r *http.Request) error {
	_, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"channel": c})
	return nil
}

func (s *Service) CreateChannel(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	var in struct {
		Name       string      `json:"name"`
		Topic      string      `json:"topic"`
		Visibility string      `json:"visibility"`
		MemberIDs  []uuid.UUID `json:"memberIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	fields := map[string]string{}
	name, msg := NormalizeChannelName(in.Name)
	if msg != "" {
		fields["name"] = msg
	}
	topic, msg := normalizeTopic(in.Topic)
	if msg != "" {
		fields["topic"] = msg
	}
	if in.Visibility != VisibilityPublic && in.Visibility != VisibilityPrivate {
		fields["visibility"] = "Choose public or private."
	}
	if len(in.MemberIDs) > maxMembersPerRequest {
		fields["memberIds"] = "Add at most 200 members at once."
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}

	id := uuid.Must(uuid.NewV7())
	var added []uuid.UUID
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO channels (id, org_id, name, topic, visibility, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
			id, m.Org.ID, name, topic, in.Visibility, m.UserID)
		if database.IsUniqueViolation(err, "channels_org_name_key") {
			return errNameTaken
		}
		if err != nil {
			return err
		}
		added, err = addMembers(ctx, tx, m.Org.ID, id, append([]uuid.UUID{m.UserID}, in.MemberIDs...))
		if err == errUnknownMember {
			return httpx.Invalid(map[string]string{"memberIds": "Choose members of this workspace."})
		}
		if err != nil {
			return err
		}
		ev := audit.FromRequest(r, "channel.created")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "channel", id.String()
		ev.Metadata = map[string]any{"name": name, "visibility": in.Visibility}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	c, err := loadChannel(ctx, s.db, m, id)
	if err != nil {
		return err
	}
	s.events.Publish(added, realtime.Event{Type: "channel.joined", Data: channelEvent{m.Org.ID, id}})
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"channel": c})
	return nil
}

// UpdateChannel renames a channel or changes its topic.
func (s *Service) UpdateChannel(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if c.ArchivedAt != nil {
		return errArchived
	}
	if err := c.fixedMembership(); err != nil {
		return err
	}
	if !c.canManage(m) {
		return httpx.ErrForbidden
	}
	var in struct {
		Name  *string `json:"name"`
		Topic *string `json:"topic"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	name, topic := c.Name, c.Topic
	fields := map[string]string{}
	if in.Name != nil {
		var msg string
		if name, msg = NormalizeChannelName(*in.Name); msg != "" {
			fields["name"] = msg
		}
	}
	if in.Topic != nil {
		var msg string
		if topic, msg = normalizeTopic(*in.Topic); msg != "" {
			fields["topic"] = msg
		}
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}

	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE channels SET name = $3, topic = $4 WHERE id = $1 AND org_id = $2`, c.ID, m.Org.ID, name, topic)
		if database.IsUniqueViolation(err, "channels_org_name_key") {
			return errNameTaken
		}
		if err != nil || name == c.Name {
			return err
		}
		ev := audit.FromRequest(r, "channel.renamed")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "channel", c.ID.String()
		ev.Metadata = map[string]any{"name": map[string]string{"from": c.Name, "to": name}}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	c.Name, c.Topic = name, topic
	s.publishToMembers(ctx, c.ID, realtime.Event{Type: "channel.updated", Data: map[string]any{
		"orgId": m.Org.ID, "channelId": c.ID, "name": name, "topic": topic,
	}})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"channel": c})
	return nil
}

// JoinChannel adds the caller to a public channel.
func (s *Service) JoinChannel(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if err := c.fixedMembership(); err != nil {
		return err
	}
	if c.ArchivedAt != nil {
		return errArchived
	}
	if !c.Joined {
		// A visible channel the caller has not joined is public (loadChannel).
		err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
			_, err := addMembers(ctx, tx, m.Org.ID, c.ID, []uuid.UUID{m.UserID})
			return err
		})
		if err != nil {
			return err
		}
		if c, err = loadChannel(ctx, s.db, m, c.ID); err != nil {
			return err
		}
		s.events.Publish([]uuid.UUID{m.UserID}, realtime.Event{Type: "channel.joined", Data: channelEvent{m.Org.ID, c.ID}})
		s.publishMembership(ctx, m.Org.ID, c.ID)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"channel": c})
	return nil
}

func (s *Service) LeaveChannel(w http.ResponseWriter, r *http.Request) error {
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if err := s.removeMember(r.Context(), m, c, m.UserID, nil); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

type channelMember struct {
	User struct {
		ID          uuid.UUID `json:"id"`
		DisplayName string    `json:"displayName"`
	} `json:"user"`
	JoinedAt time.Time `json:"joinedAt"`
}

func (s *Service) ListChannelMembers(w http.ResponseWriter, r *http.Request) error {
	_, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT u.id, u.display_name, cm.joined_at
		FROM channel_members cm
		JOIN users u ON u.id = cm.user_id
		WHERE cm.channel_id = $1 AND (cm.expires_at IS NULL OR cm.expires_at > now())
		ORDER BY lower(u.display_name), u.id`, c.ID)
	if err != nil {
		return err
	}
	members, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (channelMember, error) {
		var cm channelMember
		err := row.Scan(&cm.User.ID, &cm.User.DisplayName, &cm.JoinedAt)
		return cm, err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"members": members})
	return nil
}

// AddChannelMembers lets any channel member add workspace members to the channel.
func (s *Service) AddChannelMembers(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if err := c.fixedMembership(); err != nil {
		return err
	}
	if err := c.writableBy(); err != nil {
		return err
	}
	var in struct {
		UserIDs []uuid.UUID `json:"userIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if len(in.UserIDs) == 0 || len(in.UserIDs) > maxMembersPerRequest {
		return httpx.Invalid(map[string]string{"userIds": "Choose 1 to 200 members."})
	}
	var added []uuid.UUID
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		added, err = addMembers(ctx, tx, m.Org.ID, c.ID, in.UserIDs)
		return err
	})
	if err != nil {
		return err
	}
	if len(added) > 0 {
		s.events.Publish(added, realtime.Event{Type: "channel.joined", Data: channelEvent{m.Org.ID, c.ID}})
		s.publishMembership(ctx, m.Org.ID, c.ID)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"added": len(added)})
	return nil
}

// RemoveChannelMember removes someone from a channel; removing yourself is leaving.
func (s *Service) RemoveChannelMember(w http.ResponseWriter, r *http.Request) error {
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	targetID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	if err := c.fixedMembership(); err != nil {
		return err
	}
	if targetID != m.UserID && !c.canManage(m) {
		return httpx.ErrForbidden
	}
	if err := s.removeMember(r.Context(), m, c, targetID, r); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// removeMember takes userID out of the channel. r is set when someone else is removed,
// which is audited.
func (s *Service) removeMember(ctx context.Context, m *org.Membership, c *Channel, userID uuid.UUID, r *http.Request) error {
	if err := c.fixedMembership(); err != nil {
		return err
	}
	if c.IsDefault {
		return errLeaveDefault
	}
	removed := false
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, c.ID, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			if r == nil {
				return nil // leaving a channel twice is not an error
			}
			return httpx.ErrNotFound
		}
		removed = true
		if r == nil {
			return nil
		}
		ev := audit.FromRequest(r, "channel.member_removed")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "user", userID.String()
		ev.Metadata = map[string]any{"channel": c.Name}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil || !removed {
		return err
	}
	s.events.Publish([]uuid.UUID{userID}, realtime.Event{Type: "channel.left", Data: channelEvent{m.Org.ID, c.ID}})
	s.publishMembership(ctx, m.Org.ID, c.ID)
	return nil
}

// addMembers adds workspace members to a channel and returns who was newly added. New
// members start with everything already in the channel marked as read.
func addMembers(ctx context.Context, tx pgx.Tx, orgID, channelID uuid.UUID, userIDs []uuid.UUID) ([]uuid.UUID, error) {
	ids := unique(userIDs)
	var known int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = ANY ($2)`, orgID, ids).Scan(&known); err != nil {
		return nil, err
	}
	if known != len(ids) {
		return nil, errUnknownMember
	}
	rows, err := tx.Query(ctx, `
		INSERT INTO channel_members (channel_id, org_id, user_id, last_read_id)
		SELECT $2, $1, u, (SELECT id FROM messages WHERE channel_id = $2 ORDER BY id DESC LIMIT 1)
		FROM unnest($3::uuid[]) AS u
		ON CONFLICT DO NOTHING
		RETURNING user_id`, orgID, channelID, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

func unique(ids []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]bool, len(ids))
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
