package chat

import (
	"context"
	"net/http"
	"slices"
	"strconv"
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

type Author struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
}

type Message struct {
	ID        uuid.UUID  `json:"id"`
	ChannelID uuid.UUID  `json:"channelId"`
	ParentID  *uuid.UUID `json:"parentId,omitempty"`
	Author    *Author    `json:"author"`
	// Body holds mentions as <@user-id> tokens; Mentions names the people they refer to.
	Body      string     `json:"body"`
	CreatedAt time.Time  `json:"createdAt"`
	EditedAt  *time.Time `json:"editedAt,omitempty"`
	// Deleted marks the placeholder left by a deleted thread root; Body is empty.
	Deleted   bool           `json:"deleted,omitempty"`
	Mentions  []Author       `json:"mentions,omitempty"`
	Reactions []Reaction     `json:"reactions,omitempty"`
	Pinned    *Pin           `json:"pinned,omitempty"`
	Thread    *ThreadSummary `json:"thread,omitempty"`
	// Attachments are the files sent with the message, in upload order.
	Attachments []Attachment `json:"attachments,omitempty"`
}

// Reaction is one emoji on a message with everyone who chose it, earliest first.
type Reaction struct {
	Emoji string   `json:"emoji"`
	Users []Author `json:"users"`
}

type Pin struct {
	At time.Time `json:"at"`
	By *Author   `json:"by"`
}

// ThreadSummary describes the replies to a top-level message.
type ThreadSummary struct {
	ReplyCount  int       `json:"replyCount"`
	LastReplyAt time.Time `json:"lastReplyAt"`
	Latest      *Message  `json:"latest"`
}

type messageEvent struct {
	OrgID     uuid.UUID `json:"orgId"`
	ChannelID uuid.UUID `json:"channelId"`
	Message   *Message  `json:"message"`
}

var (
	errNotAuthor     = httpx.NewError(http.StatusForbidden, "forbidden", "You can only edit your own messages.")
	errInvalidCursor = httpx.NewError(http.StatusBadRequest, "invalid_cursor", "The page cursor is invalid.")
	errTooFast       = httpx.NewError(http.StatusTooManyRequests, "rate_limited", "You are sending messages too quickly. Wait a moment.")
	errNotRoot       = httpx.Invalid(map[string]string{"parentId": "Reply to a message of this channel that is not itself a reply."})
)

const messageQuery = `
	SELECT m.id, m.channel_id, m.parent_id, m.body, m.created_at, m.edited_at, m.deleted_at IS NOT NULL,
	       u.id, u.display_name, m.pinned_at, pb.id, pb.display_name
	FROM messages m
	LEFT JOIN users u ON u.id = m.author_id
	LEFT JOIN users pb ON pb.id = m.pinned_by`

func scanMessage(row pgx.Row) (Message, error) {
	var (
		msg                    Message
		authorID, pinnerID     *uuid.UUID
		authorName, pinnerName *string
		pinnedAt               *time.Time
	)
	if err := row.Scan(&msg.ID, &msg.ChannelID, &msg.ParentID, &msg.Body, &msg.CreatedAt, &msg.EditedAt, &msg.Deleted,
		&authorID, &authorName, &pinnedAt, &pinnerID, &pinnerName); err != nil {
		return Message{}, err
	}
	if authorID != nil {
		msg.Author = &Author{ID: *authorID, DisplayName: *authorName}
	}
	if pinnedAt != nil {
		msg.Pinned = &Pin{At: *pinnedAt}
		if pinnerID != nil {
			msg.Pinned.By = &Author{ID: *pinnerID, DisplayName: *pinnerName}
		}
	}
	return msg, nil
}

func queryMessages(ctx context.Context, q database.Querier, filter string, args ...any) ([]*Message, error) {
	rows, err := q.Query(ctx, messageQuery+filter, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (*Message, error) {
		msg, err := scanMessage(row)
		return &msg, err
	})
}

// loadMessage returns a message of the channel without reactions, mentions or thread.
func loadMessage(ctx context.Context, q database.Querier, channelID, messageID uuid.UUID) (*Message, error) {
	msgs, err := queryMessages(ctx, q, ` WHERE m.channel_id = $1 AND m.id = $2`, channelID, messageID)
	if err != nil {
		return nil, err
	}
	if len(msgs) == 0 {
		return nil, httpx.ErrNotFound
	}
	return msgs[0], nil
}

// loadFullMessage returns a message with everything clients display.
func loadFullMessage(ctx context.Context, q database.Querier, channelID, messageID uuid.UUID) (*Message, error) {
	msg, err := loadMessage(ctx, q, channelID, messageID)
	if err != nil {
		return nil, err
	}
	return msg, enrich(ctx, q, []*Message{msg})
}

// liveMessage loads a message that may be changed: it must exist and not be a
// deleted placeholder.
func liveMessage(ctx context.Context, q database.Querier, channelID, messageID uuid.UUID) (*Message, error) {
	msg, err := loadMessage(ctx, q, channelID, messageID)
	if err == nil && msg.Deleted {
		err = httpx.ErrNotFound
	}
	return msg, err
}

func messageIDFromRequest(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, "messageID"))
	if err != nil {
		return uuid.Nil, httpx.ErrNotFound
	}
	return id, nil
}

// ListMessages returns one page of top-level history, oldest first. Without "before" it
// is the newest page; pass the oldest message ID as "before" for the previous page.
func (s *Service) ListMessages(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	_, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			return httpx.Invalid(map[string]string{"limit": "Choose a limit between 1 and 100."})
		}
		limit = n
	}
	var before *uuid.UUID
	if v := r.URL.Query().Get("before"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			return errInvalidCursor
		}
		before = &id
	}

	msgs, err := queryMessages(ctx, s.db, `
		WHERE m.channel_id = $1 AND m.parent_id IS NULL AND ($2::uuid IS NULL OR m.id < $2)
		ORDER BY m.id DESC
		LIMIT $3`, c.ID, before, limit+1)
	if err != nil {
		return err
	}
	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}
	slices.Reverse(msgs)
	if err := enrich(ctx, s.db, msgs); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"messages": msgs, "hasMore": hasMore})
	return nil
}

// PostMessage sends a message, or with parentId a thread reply, to a channel the caller
// has joined. A top-level message marks the channel as read for its author.
func (s *Service) PostMessage(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if err := c.writableBy(); err != nil {
		return err
	}
	if !s.postsByUser.Allow(m.UserID.String()) {
		return errTooFast
	}
	var in struct {
		Body          string      `json:"body"`
		ParentID      *uuid.UUID  `json:"parentId"`
		AttachmentIDs []uuid.UUID `json:"attachmentIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	body, problem := normalizeBody(in.Body)
	if problem != "" && !(body == "" && len(in.AttachmentIDs) > 0) { // files alone are a message
		return httpx.Invalid(map[string]string{"body": problem})
	}
	if in.ParentID != nil {
		root, err := loadMessage(ctx, s.db, c.ID, *in.ParentID)
		if err != nil || root.ParentID != nil {
			return errNotRoot
		}
	}

	id := uuid.Must(uuid.NewV7())
	var notified []uuid.UUID
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO messages (id, org_id, channel_id, parent_id, author_id, body) VALUES ($1, $2, $3, $4, $5, $6)`,
			id, m.Org.ID, c.ID, in.ParentID, m.UserID, body); err != nil {
			return err
		}
		if err := attachToMessage(ctx, tx, c.ID, m.UserID, id, in.AttachmentIDs); err != nil {
			return err
		}
		if err := saveMentions(ctx, tx, m.Org.ID, id, body); err != nil {
			return err
		}
		var err error
		if notified, err = notify(ctx, tx, m.Org.ID, c.ID, id, m.UserID, in.ParentID); err != nil {
			return err
		}
		if in.ParentID != nil {
			return nil
		}
		_, err = tx.Exec(ctx, `UPDATE channel_members SET last_read_id = $3 WHERE channel_id = $1 AND user_id = $2`, c.ID, m.UserID, id)
		return err
	})
	if err != nil {
		return err
	}
	msg, err := loadFullMessage(ctx, s.db, c.ID, id)
	if err != nil {
		return err
	}
	s.publishToMembers(ctx, c.ID, realtime.Event{Type: "message.created", Data: messageEvent{m.Org.ID, c.ID, msg}})
	if in.ParentID != nil {
		s.publishMessage(ctx, m.Org.ID, c.ID, *in.ParentID) // new reply count and latest reply
	}
	s.sendNotifications(ctx, m.Org.ID, id, notified)
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"message": msg})
	return nil
}

// EditMessage changes the text of the caller's own message.
func (s *Service) EditMessage(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	messageID, err := messageIDFromRequest(r)
	if err != nil {
		return err
	}
	var in struct {
		Body string `json:"body"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	body, problem := normalizeBody(in.Body)
	if problem != "" {
		return httpx.Invalid(map[string]string{"body": problem})
	}
	msg, err := liveMessage(ctx, s.db, c.ID, messageID)
	if err != nil {
		return err
	}
	if msg.Author == nil || msg.Author.ID != m.UserID {
		return errNotAuthor
	}
	if err := c.writableBy(); err != nil {
		return err
	}
	if body != msg.Body {
		var notified []uuid.UUID
		err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `UPDATE messages SET body = $3, edited_at = now() WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL`,
				messageID, c.ID, body)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return httpx.ErrNotFound // deleted meanwhile
			}
			if err := saveMentions(ctx, tx, m.Org.ID, messageID, body); err != nil {
				return err
			}
			notified, err = notify(ctx, tx, m.Org.ID, c.ID, messageID, m.UserID, nil) // people newly mentioned
			return err
		})
		if err != nil {
			return err
		}
		defer s.sendNotifications(ctx, m.Org.ID, messageID, notified)
		s.publishMessage(ctx, m.Org.ID, c.ID, messageID)
		if msg.ParentID != nil {
			s.publishMessage(ctx, m.Org.ID, c.ID, *msg.ParentID) // the root shows the latest reply
		}
	}
	full, err := loadFullMessage(ctx, s.db, c.ID, messageID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"message": full})
	return nil
}

// DeleteMessage removes a message. Authors delete their own; in channels, holders of
// messages.manage delete anyone's, which is audited. A thread root with replies leaves a
// placeholder, which goes away with its last reply.
func (s *Service) DeleteMessage(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	messageID, err := messageIDFromRequest(r)
	if err != nil {
		return err
	}
	if c.ArchivedAt != nil {
		return errArchived
	}
	var (
		parentID    *uuid.UUID
		placeholder bool // the message stays as "deleted" because it has replies
		rootGone    bool // a placeholder root lost its last reply and was removed
		files       []uuid.UUID
	)
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var authorID *uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT author_id, parent_id, EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = m.id)
			FROM messages m WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL
			FOR UPDATE`, messageID, c.ID).Scan(&authorID, &parentID, &placeholder)
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		if err != nil {
			return err
		}
		moderated := authorID == nil || *authorID != m.UserID
		// Moderation covers channels; direct conversations stay private.
		if moderated && (!m.Can(org.PermMessagesManage) || c.isDirect()) {
			return httpx.ErrForbidden
		}
		if files, err = detachFiles(ctx, tx, messageID); err != nil {
			return err
		}
		if placeholder {
			_, err = tx.Exec(ctx, `
				UPDATE messages SET body = '', deleted_at = now(), edited_at = NULL, pinned_at = NULL, pinned_by = NULL
				WHERE id = $1`, messageID)
			if err == nil {
				_, err = tx.Exec(ctx, `DELETE FROM message_reactions WHERE message_id = $1`, messageID)
			}
			if err == nil {
				_, err = tx.Exec(ctx, `DELETE FROM message_mentions WHERE message_id = $1`, messageID)
			}
		} else {
			_, err = tx.Exec(ctx, `DELETE FROM messages WHERE id = $1`, messageID)
		}
		if err != nil {
			return err
		}
		if parentID != nil {
			tag, err := tx.Exec(ctx, `
				DELETE FROM messages p WHERE p.id = $1 AND p.deleted_at IS NOT NULL
				  AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = p.id)`, *parentID)
			if err != nil {
				return err
			}
			rootGone = tag.RowsAffected() == 1
		}
		if !moderated {
			return nil
		}
		ev := audit.FromRequest(r, "message.deleted")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "message", messageID.String()
		ev.Metadata = map[string]any{"channel": c.Name}
		if authorID != nil {
			ev.Metadata["authorId"] = authorID.String()
		}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.removeFiles(m.Org.ID, files)
	if placeholder {
		s.publishMessage(ctx, m.Org.ID, c.ID, messageID)
	} else {
		s.publishDeleted(ctx, m.Org.ID, c.ID, messageID, parentID)
	}
	switch {
	case rootGone:
		s.publishDeleted(ctx, m.Org.ID, c.ID, *parentID, nil)
	case parentID != nil:
		s.publishMessage(ctx, m.Org.ID, c.ID, *parentID)
	}
	httpx.NoContent(w)
	return nil
}

// publishMessage sends the current state of a message to the channel's members.
func (s *Service) publishMessage(ctx context.Context, orgID, channelID, messageID uuid.UUID) {
	msg, err := loadFullMessage(ctx, s.db, channelID, messageID)
	if err != nil {
		return
	}
	s.publishToMembers(ctx, channelID, realtime.Event{Type: "message.updated", Data: messageEvent{orgID, channelID, msg}})
}

func (s *Service) publishDeleted(ctx context.Context, orgID, channelID, messageID uuid.UUID, parentID *uuid.UUID) {
	s.publishToMembers(ctx, channelID, realtime.Event{Type: "message.deleted", Data: map[string]any{
		"orgId": orgID, "channelId": channelID, "messageId": messageID, "parentId": parentID,
	}})
}

// MarkRead moves the caller's read marker forward to a message; it never moves back.
func (s *Service) MarkRead(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if !c.Joined {
		return errNotMember
	}
	var in struct {
		MessageID uuid.UUID `json:"messageId"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `
		UPDATE channel_members SET last_read_id = $3
		WHERE channel_id = $1 AND user_id = $2
		  AND (last_read_id IS NULL OR last_read_id < $3)
		  AND EXISTS (SELECT 1 FROM messages WHERE id = $3 AND channel_id = $1)`, c.ID, m.UserID, in.MessageID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		// Other tabs and devices of the same user clear their unread badge.
		s.events.Publish([]uuid.UUID{m.UserID}, realtime.Event{Type: "channel.read", Data: map[string]any{
			"orgId": m.Org.ID, "channelId": c.ID, "lastReadId": in.MessageID,
		}})
	}
	// Reading a channel also settles its notifications.
	if err := s.markNotificationsRead(ctx, m.Org.ID, m.UserID, nil, &c.ID, false); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}
