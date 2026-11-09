package chat

import (
	"bytes"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

// Direct conversations are channels of kind "direct" with a fixed set of participants
// (docs/architecture/phase-2.md).

const (
	maxParticipants = 9
	previewLength   = 200
)

var errNotSharing = httpx.NewError(http.StatusForbidden, "forbidden", "You can only message people you share a channel with.")

// ListConversations returns the caller's direct conversations, newest activity first.
// A conversation someone else opened appears once it has a message.
func (s *Service) ListConversations(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	convs, err := queryChannels(ctx, s.db, m.Org.ID, m.UserID, `
		AND c.kind = 'direct' AND cm.user_id IS NOT NULL
		AND (c.created_by = $2 OR EXISTS (SELECT 1 FROM messages x WHERE x.channel_id = c.id))
		ORDER BY coalesce((SELECT x.created_at FROM messages x WHERE x.channel_id = c.id ORDER BY x.id DESC LIMIT 1), c.created_at) DESC
		LIMIT 200`)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(convs))
	for i, c := range convs {
		ids[i] = c.ID
	}
	last, err := queryMessages(ctx, s.db, ` WHERE m.id IN (
		SELECT DISTINCT ON (x.channel_id) x.id FROM messages x
		WHERE x.channel_id = ANY ($1) AND x.parent_id IS NULL AND x.deleted_at IS NULL
		ORDER BY x.channel_id, x.id DESC)`, ids)
	if err != nil {
		return err
	}
	if err := enrichMentions(ctx, s.db, last); err != nil {
		return err
	}
	if err := enrichAttachments(ctx, s.db, last); err != nil {
		return err
	}
	byChannel := make(map[uuid.UUID]*Message, len(last))
	for _, msg := range last {
		msg.Body = preview(msg.Body)
		byChannel[msg.ChannelID] = msg
	}
	for i := range convs {
		convs[i].LastMessage = byChannel[convs[i].ID]
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"conversations": convs})
	return nil
}

func preview(body string) string {
	if utf8.RuneCountInString(body) <= previewLength {
		return body
	}
	cut := string([]rune(body)[:previewLength])
	// Never end inside a <@user-id> mention token.
	if i := strings.LastIndex(cut, "<@"); i >= 0 && !strings.Contains(cut[i:], ">") {
		cut = cut[:i]
	}
	return cut + "…"
}

// OpenConversation finds or creates the conversation between the caller and userIds.
// Without members.view, the caller may only write to people they share a channel with.
func (s *Service) OpenConversation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	var in struct {
		UserIDs []uuid.UUID `json:"userIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	people := unique(append([]uuid.UUID{m.UserID}, in.UserIDs...))
	if len(people) > maxParticipants {
		return httpx.Invalid(map[string]string{"userIds": "A conversation can have at most 9 people."})
	}
	others := slices.Clone(people[1:])
	// One canonical order, so each set of people maps to one row.
	slices.SortFunc(people, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })

	var (
		channelID uuid.UUID
		created   bool
	)
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var known int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = ANY ($2)`,
			m.Org.ID, people).Scan(&known); err != nil {
			return err
		}
		if known != len(people) {
			return httpx.Invalid(map[string]string{"userIds": "Choose members of this workspace."})
		}
		if len(others) > 0 && !m.Can(org.PermMembersView) {
			var shared int
			if err := tx.QueryRow(ctx, `
				SELECT count(DISTINCT theirs.user_id)
				FROM channel_members mine
				JOIN channel_members theirs ON theirs.channel_id = mine.channel_id
				WHERE mine.org_id = $1 AND mine.user_id = $2 AND theirs.user_id = ANY ($3)`,
				m.Org.ID, m.UserID, others).Scan(&shared); err != nil {
				return err
			}
			if shared != len(others) {
				return errNotSharing
			}
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO channels (id, org_id, kind, visibility, participants, created_by)
			VALUES ($1, $2, 'direct', 'private', $3, $4)
			ON CONFLICT (org_id, participants) WHERE kind = 'direct' DO NOTHING`,
			uuid.Must(uuid.NewV7()), m.Org.ID, people, m.UserID)
		if err != nil {
			return err
		}
		created = tag.RowsAffected() == 1
		if err := tx.QueryRow(ctx, `SELECT id FROM channels WHERE org_id = $1 AND kind = 'direct' AND participants = $2`,
			m.Org.ID, people).Scan(&channelID); err != nil {
			return err
		}
		// Participants who left the workspace and came back rejoin the conversation.
		_, err = addMembers(ctx, tx, m.Org.ID, channelID, people)
		return err
	})
	if err != nil {
		return err
	}
	c, err := loadChannel(ctx, s.db, m, channelID)
	if err != nil {
		return err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
		// Only the caller's other tabs learn about it now; the others when a message arrives.
		s.events.Publish([]uuid.UUID{m.UserID}, realtime.Event{Type: "channel.joined", Data: channelEvent{m.Org.ID, c.ID}})
	}
	httpx.WriteJSON(w, status, map[string]any{"conversation": c})
	return nil
}
