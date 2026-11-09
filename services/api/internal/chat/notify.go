package chat

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

// Typing indicators and notifications (docs/architecture/phase-2.md, increment 2.4).

// Notification tells someone they were mentioned, or that a thread they take part in has
// a new reply.
type Notification struct {
	ID          uuid.UUID `json:"id"`
	Kind        string    `json:"kind"` // mention or reply
	ChannelID   uuid.UUID `json:"channelId"`
	ChannelKind string    `json:"channelKind"`
	ChannelName string    `json:"channelName"` // empty for direct conversations
	Actor       *Author   `json:"actor"`
	// Message is shortened for display; its parentId leads to the thread.
	Message   *Message  `json:"message"`
	CreatedAt time.Time `json:"createdAt"`
	Read      bool      `json:"read"`
}

const notificationPage = 50

// notify records notifications for a new or edited message: people it mentions, and for
// replies everyone already in the thread. Only current channel members are notified,
// never the author, and each person at most once per message. It returns who to tell.
func notify(ctx context.Context, tx pgx.Tx, orgID, channelID uuid.UUID, msgID, authorID uuid.UUID, parentID *uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `
		INSERT INTO notifications (id, org_id, user_id, kind, channel_id, message_id, actor_id)
		SELECT gen_random_uuid(), $1, mm.user_id, 'mention', $2, $3, $4
		FROM message_mentions mm
		JOIN channel_members cm ON cm.channel_id = $2 AND cm.user_id = mm.user_id AND (cm.expires_at IS NULL OR cm.expires_at > now())
		WHERE mm.message_id = $3 AND mm.user_id <> $4
		ON CONFLICT (user_id, message_id) DO NOTHING
		RETURNING user_id`, orgID, channelID, msgID, authorID)
	if err != nil {
		return nil, err
	}
	notified, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil || parentID == nil {
		return notified, err
	}
	rows, err = tx.Query(ctx, `
		INSERT INTO notifications (id, org_id, user_id, kind, channel_id, message_id, actor_id)
		SELECT gen_random_uuid(), $1, p.author_id, 'reply', $2, $3, $4
		FROM (SELECT author_id FROM messages WHERE id = $5
		      UNION SELECT author_id FROM messages WHERE parent_id = $5) p
		JOIN channel_members cm ON cm.channel_id = $2 AND cm.user_id = p.author_id AND (cm.expires_at IS NULL OR cm.expires_at > now())
		WHERE p.author_id <> $4
		ON CONFLICT (user_id, message_id) DO NOTHING
		RETURNING user_id`, orgID, channelID, msgID, authorID, *parentID)
	if err != nil {
		return nil, err
	}
	replied, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	return append(notified, replied...), err
}

// loadNotifications returns notifications in orgID matching filter (which starts with
// AND and may use $2 onward), newest first and at most limit, ready for display. owners
// holds the person each one is for.
func loadNotifications(ctx context.Context, q database.Querier, orgID uuid.UUID, limit int, filter string, args ...any) (list []Notification, owners []uuid.UUID, err error) {
	rows, err := q.Query(ctx, `
		SELECT n.user_id, n.id, n.kind, c.id, c.kind, coalesce(c.name, ''), a.id, a.display_name, n.message_id, n.created_at, n.read_at IS NOT NULL
		FROM notifications n
		JOIN channels c ON c.id = n.channel_id
		LEFT JOIN users a ON a.id = n.actor_id
		WHERE n.org_id = $1`+filter+`
		  -- only what the person may still read: public channels, or ones they are in now
		  AND ((c.kind = 'channel' AND c.visibility = 'public') OR EXISTS (
		      SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = n.user_id
		        AND (cm.expires_at IS NULL OR cm.expires_at > now())))
		ORDER BY n.created_at DESC, n.id
		LIMIT `+strconv.Itoa(limit), append([]any{orgID}, args...)...)
	if err != nil {
		return nil, nil, err
	}
	var messageIDs []uuid.UUID
	list, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (Notification, error) {
		var (
			n         Notification
			owner     uuid.UUID
			actorID   *uuid.UUID
			actorName *string
			messageID uuid.UUID
		)
		err := row.Scan(&owner, &n.ID, &n.Kind, &n.ChannelID, &n.ChannelKind, &n.ChannelName, &actorID, &actorName, &messageID, &n.CreatedAt, &n.Read)
		if actorID != nil {
			n.Actor = &Author{ID: *actorID, DisplayName: *actorName}
		}
		n.Message = &Message{ID: messageID}
		owners = append(owners, owner)
		messageIDs = append(messageIDs, messageID)
		return n, err
	})
	if err != nil || len(list) == 0 {
		return list, owners, err
	}
	msgs, err := queryMessages(ctx, q, ` WHERE m.id = ANY ($1)`, unique(messageIDs))
	if err != nil {
		return nil, nil, err
	}
	if err := enrichMentions(ctx, q, msgs); err != nil {
		return nil, nil, err
	}
	for _, msg := range msgs {
		msg.Body = preview(msg.Body)
	}
	index := byID(msgs)
	for i := range list {
		if msg := index[list[i].Message.ID]; msg != nil {
			list[i].Message = msg
		}
	}
	return list, owners, nil
}

func unreadNotifications(ctx context.Context, q database.Querier, orgID, userID uuid.UUID) (int, error) {
	var n int
	err := q.QueryRow(ctx, `
		SELECT count(*) FROM notifications n
		JOIN channels c ON c.id = n.channel_id
		WHERE n.org_id = $1 AND n.user_id = $2 AND n.read_at IS NULL
		  AND ((c.kind = 'channel' AND c.visibility = 'public') OR EXISTS (
		      SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2
		        AND (cm.expires_at IS NULL OR cm.expires_at > now())))`, orgID, userID).Scan(&n)
	return n, err
}

// sendNotifications pushes each recipient's notification for msgID to them. One query
// loads them all: a busy thread or a message with many mentions has many recipients.
func (s *Service) sendNotifications(ctx context.Context, orgID, msgID uuid.UUID, recipients []uuid.UUID) {
	recipients = unique(recipients)
	if len(recipients) == 0 {
		return
	}
	// Each person has at most one notification per message.
	list, owners, err := loadNotifications(ctx, s.db, orgID, len(recipients),
		` AND n.message_id = $2 AND n.user_id = ANY ($3)`, msgID, recipients)
	if err != nil {
		slog.Warn("chat: load notifications to send", "message", msgID, "error", err)
		return
	}
	for i, n := range list {
		s.events.Publish([]uuid.UUID{owners[i]}, realtime.Event{Type: "notification.created", Data: map[string]any{
			"orgId": orgID, "notification": n,
		}})
	}
}

// ListNotifications returns the caller's latest notifications and how many are unread.
func (s *Service) ListNotifications(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	list, _, err := loadNotifications(ctx, s.db, m.Org.ID, notificationPage, ` AND n.user_id = $2`, m.UserID)
	if err != nil {
		return err
	}
	unread, err := unreadNotifications(ctx, s.db, m.Org.ID, m.UserID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"notifications": list, "unreadCount": unread})
	return nil
}

// ReadNotifications marks notifications read: {"ids": [...]}, {"channelId": ...} or
// {"all": true}.
func (s *Service) ReadNotifications(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	var in struct {
		IDs       []uuid.UUID `json:"ids"`
		ChannelID *uuid.UUID  `json:"channelId"`
		All       bool        `json:"all"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if len(in.IDs) > notificationPage {
		return httpx.Invalid(map[string]string{"ids": "Mark at most 50 notifications at once."})
	}
	if err := s.markNotificationsRead(ctx, m.Org.ID, m.UserID, in.IDs, in.ChannelID, in.All); err != nil {
		return err
	}
	unread, err := unreadNotifications(ctx, s.db, m.Org.ID, m.UserID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"unreadCount": unread})
	return nil
}

func (s *Service) markNotificationsRead(ctx context.Context, orgID, userID uuid.UUID, ids []uuid.UUID, channelID *uuid.UUID, all bool) error {
	if len(ids) == 0 && channelID == nil && !all {
		return nil
	}
	tag, err := s.db.Exec(ctx, `
		UPDATE notifications SET read_at = now()
		WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL
		  AND ($3 OR id = ANY ($4) OR channel_id = $5)`, orgID, userID, all, ids, channelID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	// The person's other windows update their bell.
	s.events.Publish([]uuid.UUID{userID}, realtime.Event{Type: "notification.read", Data: map[string]any{"orgId": orgID}})
	return nil
}

// Typing relays "someone is typing" to the other members of a channel; nothing is
// stored. Clients call it at most every few seconds while typing.
func (s *Service) Typing(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if err := c.writableBy(); err != nil {
		return err
	}
	var in struct {
		ParentID *uuid.UUID `json:"parentId"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if s.typingByUser.Allow(m.UserID.String()) {
		ids, err := memberIDs(ctx, s.db, c.ID)
		if err != nil {
			return err
		}
		others := ids[:0]
		for _, id := range ids {
			if id != m.UserID {
				others = append(others, id)
			}
		}
		s.events.Publish(others, realtime.Event{Type: "typing", Data: map[string]any{
			"orgId": m.Org.ID, "channelId": c.ID, "parentId": in.ParentID,
			"user": Author{ID: m.UserID, DisplayName: identity(ctx).User.DisplayName},
		}})
	}
	httpx.NoContent(w)
	return nil
}
