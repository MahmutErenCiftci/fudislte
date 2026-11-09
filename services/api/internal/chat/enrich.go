package chat

import (
	"context"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
)

// enrich adds what clients display beyond the message row: thread summaries for
// top-level messages, then reactions and mentions for those messages and their latest
// replies, plus their files. Each step is one query for the whole page.
func enrich(ctx context.Context, q database.Querier, msgs []*Message) error {
	if len(msgs) == 0 {
		return nil
	}
	latest, err := enrichThreads(ctx, q, msgs)
	if err != nil {
		return err
	}
	all := append(append([]*Message{}, msgs...), latest...)
	if err := enrichReactions(ctx, q, all); err != nil {
		return err
	}
	if err := enrichAttachments(ctx, q, all); err != nil {
		return err
	}
	return enrichMentions(ctx, q, all)
}

func ids(msgs []*Message) []uuid.UUID {
	out := make([]uuid.UUID, len(msgs))
	for i, m := range msgs {
		out[i] = m.ID
	}
	return out
}

func byID(msgs []*Message) map[uuid.UUID]*Message {
	out := make(map[uuid.UUID]*Message, len(msgs))
	for _, m := range msgs {
		out[m.ID] = m
	}
	return out
}

// enrichThreads sets the thread summary of every top-level message that has replies and
// returns the latest replies it attached.
func enrichThreads(ctx context.Context, q database.Querier, msgs []*Message) ([]*Message, error) {
	var roots []uuid.UUID
	for _, m := range msgs {
		if m.ParentID == nil {
			roots = append(roots, m.ID)
		}
	}
	if len(roots) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx, `
		SELECT parent_id, count(*), max(created_at) FROM messages
		WHERE parent_id = ANY ($1) GROUP BY parent_id`, roots)
	if err != nil {
		return nil, err
	}
	index := byID(msgs)
	type summary struct {
		root  uuid.UUID
		count int
		last  time.Time
	}
	sums, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (summary, error) {
		var s summary
		err := row.Scan(&s.root, &s.count, &s.last)
		return s, err
	})
	if err != nil {
		return nil, err
	}
	if len(sums) == 0 {
		return nil, nil
	}
	withReplies := make([]uuid.UUID, len(sums))
	for i, s := range sums {
		index[s.root].Thread = &ThreadSummary{ReplyCount: s.count, LastReplyAt: s.last}
		withReplies[i] = s.root
	}
	latest, err := queryMessages(ctx, q, ` WHERE m.id IN (
		SELECT DISTINCT ON (x.parent_id) x.id FROM messages x
		WHERE x.parent_id = ANY ($1) ORDER BY x.parent_id, x.id DESC)`, withReplies)
	if err != nil {
		return nil, err
	}
	for _, reply := range latest {
		index[*reply.ParentID].Thread.Latest = reply
	}
	return latest, nil
}

func enrichReactions(ctx context.Context, q database.Querier, msgs []*Message) error {
	rows, err := q.Query(ctx, `
		SELECT r.message_id, r.emoji, u.id, u.display_name
		FROM message_reactions r
		JOIN users u ON u.id = r.user_id
		WHERE r.message_id = ANY ($1)
		ORDER BY r.message_id, r.created_at, r.emoji`, ids(msgs))
	if err != nil {
		return err
	}
	index := byID(msgs)
	var (
		messageID uuid.UUID
		emoji     string
		user      Author
	)
	_, err = pgx.ForEachRow(rows, []any{&messageID, &emoji, &user.ID, &user.DisplayName}, func() error {
		m := index[messageID]
		for i := range m.Reactions {
			if m.Reactions[i].Emoji == emoji {
				m.Reactions[i].Users = append(m.Reactions[i].Users, user)
				return nil
			}
		}
		m.Reactions = append(m.Reactions, Reaction{Emoji: emoji, Users: []Author{user}})
		return nil
	})
	return err
}

func enrichMentions(ctx context.Context, q database.Querier, msgs []*Message) error {
	if len(msgs) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `
		SELECT mm.message_id, u.id, u.display_name
		FROM message_mentions mm
		JOIN users u ON u.id = mm.user_id
		WHERE mm.message_id = ANY ($1)`, ids(msgs))
	if err != nil {
		return err
	}
	index := byID(msgs)
	var (
		messageID uuid.UUID
		user      Author
	)
	_, err = pgx.ForEachRow(rows, []any{&messageID, &user.ID, &user.DisplayName}, func() error {
		index[messageID].Mentions = append(index[messageID].Mentions, user)
		return nil
	})
	return err
}

var mentionToken = regexp.MustCompile(`<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>`)

// mentionedIDs returns the users a message body mentions, once each.
func mentionedIDs(body string) []uuid.UUID {
	var out []uuid.UUID
	for _, m := range mentionToken.FindAllStringSubmatch(body, 50) {
		if id, err := uuid.Parse(m[1]); err == nil {
			out = append(out, id)
		}
	}
	return unique(out)
}

// saveMentions records which workspace members a message mentions, replacing earlier
// records when the message is edited.
func saveMentions(ctx context.Context, tx pgx.Tx, orgID, messageID uuid.UUID, body string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM message_mentions WHERE message_id = $1`, messageID); err != nil {
		return err
	}
	mentioned := mentionedIDs(body)
	if len(mentioned) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO message_mentions (message_id, user_id)
		SELECT $1, user_id FROM memberships WHERE org_id = $2 AND user_id = ANY ($3)`, messageID, orgID, mentioned)
	return err
}
