package chat

import (
	"context"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

// Threads, reactions and pins (docs/architecture/phase-2.md, increment 2.3).

const (
	maxReactionKinds = 20
	maxPins          = 50
	maxReplies       = 1000
)

var (
	errBadEmoji         = httpx.Invalid(map[string]string{"emoji": "Choose an emoji."})
	errTooManyReactions = httpx.NewError(http.StatusConflict, "too_many_reactions", "A message can have at most 20 different reactions.")
	errTooManyPins      = httpx.NewError(http.StatusConflict, "too_many_pins", "A channel can have at most 50 pinned messages. Unpin one first.")
)

// messageFromRequest loads the {channelID} channel and its {messageID} message for the
// calling member.
func (s *Service) messageFromRequest(r *http.Request) (*org.Membership, *Channel, *Message, error) {
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return nil, nil, nil, err
	}
	messageID, err := messageIDFromRequest(r)
	if err != nil {
		return nil, nil, nil, err
	}
	msg, err := liveMessage(r.Context(), s.db, c.ID, messageID)
	return m, c, msg, err
}

// ListReplies returns a thread: its root and every reply, oldest first.
func (s *Service) ListReplies(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	_, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	messageID, err := messageIDFromRequest(r)
	if err != nil {
		return err
	}
	root, err := loadFullMessage(ctx, s.db, c.ID, messageID)
	if err != nil {
		return err
	}
	if root.ParentID != nil {
		return httpx.ErrNotFound
	}
	replies, err := queryMessages(ctx, s.db, ` WHERE m.parent_id = $1 ORDER BY m.id LIMIT $2`, root.ID, maxReplies)
	if err != nil {
		return err
	}
	if err := enrich(ctx, s.db, replies); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"root": root, "replies": replies})
	return nil
}

// validEmoji accepts 1–16 characters made only of emoji code points: symbols,
// modifiers, joiners, variation selectors and keycaps.
func validEmoji(s string) bool {
	if n := utf8.RuneCountInString(s); n < 1 || n > 16 {
		return false
	}
	for _, r := range s {
		switch {
		case unicode.In(r, unicode.So, unicode.Sk, unicode.Mn, unicode.Me):
		case r == 0x200D, r == 0xFE0F, r == 0x20E3: // zero-width joiner, emoji presentation, keycap
		case r >= '0' && r <= '9', r == '#', r == '*':
			if !strings.ContainsRune(s, 0x20E3) {
				return false // digits only as keycap bases ("1️⃣")
			}
		default:
			return false
		}
	}
	return true
}

func (s *Service) reactionTarget(r *http.Request) (*org.Membership, *Channel, *Message, error) {
	m, c, msg, err := s.messageFromRequest(r)
	if err != nil {
		return nil, nil, nil, err
	}
	if err := c.writableBy(); err != nil {
		return nil, nil, nil, err
	}
	if !s.reactionsByUser.Allow(m.UserID.String()) {
		return nil, nil, nil, errTooFast
	}
	return m, c, msg, nil
}

// AddReaction adds the caller's emoji to a message; adding it twice changes nothing.
func (s *Service) AddReaction(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, msg, err := s.reactionTarget(r)
	if err != nil {
		return err
	}
	var in struct {
		Emoji string `json:"emoji"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if !validEmoji(in.Emoji) {
		return errBadEmoji
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var others int
		if err := tx.QueryRow(ctx, `SELECT count(DISTINCT emoji) FROM message_reactions WHERE message_id = $1 AND emoji <> $2`,
			msg.ID, in.Emoji).Scan(&others); err != nil {
			return err
		}
		if others >= maxReactionKinds {
			return errTooManyReactions
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			msg.ID, m.UserID, in.Emoji)
		return err
	})
	if err != nil {
		return err
	}
	return s.respondReactions(ctx, w, m.Org.ID, c.ID, msg)
}

// RemoveReaction takes back the caller's ?emoji= reaction.
func (s *Service) RemoveReaction(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, msg, err := s.reactionTarget(r)
	if err != nil {
		return err
	}
	emoji := r.URL.Query().Get("emoji")
	if !validEmoji(emoji) {
		return errBadEmoji
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
		msg.ID, m.UserID, emoji); err != nil {
		return err
	}
	return s.respondReactions(ctx, w, m.Org.ID, c.ID, msg)
}

// respondReactions sends a message's reactions to the channel's members and the caller.
func (s *Service) respondReactions(ctx context.Context, w http.ResponseWriter, orgID, channelID uuid.UUID, msg *Message) error {
	msg.Reactions = nil
	if err := enrichReactions(ctx, s.db, []*Message{msg}); err != nil {
		return err
	}
	reactions := msg.Reactions
	if reactions == nil {
		reactions = []Reaction{}
	}
	s.publishToMembers(ctx, channelID, realtime.Event{Type: "message.reactions", Data: map[string]any{
		"orgId": orgID, "channelId": channelID, "messageId": msg.ID, "parentId": msg.ParentID, "reactions": reactions,
	}})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"reactions": reactions})
	return nil
}

// PinMessage pins a message to its channel; any member may pin.
func (s *Service) PinMessage(w http.ResponseWriter, r *http.Request) error {
	return s.setPinned(w, r, true)
}

func (s *Service) UnpinMessage(w http.ResponseWriter, r *http.Request) error {
	return s.setPinned(w, r, false)
}

func (s *Service) setPinned(w http.ResponseWriter, r *http.Request, pinned bool) error {
	ctx := r.Context()
	m, c, msg, err := s.messageFromRequest(r)
	if err != nil {
		return err
	}
	if err := c.writableBy(); err != nil {
		return err
	}
	if pinned != (msg.Pinned != nil) {
		err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
			if pinned {
				var count int
				// Lock the channel row so concurrent pins cannot pass the limit together.
				if _, err := tx.Exec(ctx, `SELECT 1 FROM channels WHERE id = $1 FOR UPDATE`, c.ID); err != nil {
					return err
				}
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL`, c.ID).Scan(&count); err != nil {
					return err
				}
				if count >= maxPins {
					return errTooManyPins
				}
				_, err := tx.Exec(ctx, `UPDATE messages SET pinned_at = now(), pinned_by = $2 WHERE id = $1 AND deleted_at IS NULL`, msg.ID, m.UserID)
				return err
			}
			_, err := tx.Exec(ctx, `UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1`, msg.ID)
			return err
		})
		if err != nil {
			return err
		}
		s.publishMessage(ctx, m.Org.ID, c.ID, msg.ID)
	}
	full, err := loadFullMessage(ctx, s.db, c.ID, msg.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"message": full})
	return nil
}

// ListPins returns a channel's pinned messages, most recently pinned first.
func (s *Service) ListPins(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	_, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	msgs, err := queryMessages(ctx, s.db, ` WHERE m.channel_id = $1 AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC LIMIT $2`, c.ID, maxPins)
	if err != nil {
		return err
	}
	if err := enrich(ctx, s.db, msgs); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"messages": msgs})
	return nil
}
