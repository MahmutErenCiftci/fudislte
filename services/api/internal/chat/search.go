package chat

import (
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
)

// Message search (increment 2.5): PostgreSQL full-text search over the channels and
// conversations the caller has joined, plus public channels they may join.

type SearchResult struct {
	Message *Message `json:"message"`
	Channel *Channel `json:"channel"`
}

const maxSearchTerms = 8

// searchQuery turns what someone typed into a tsquery: every word must match, each as a
// prefix. Only letters and digits survive, so tsquery syntax cannot be injected.
func searchQuery(input string) string {
	// No lower-casing here: the "simple" dictionary folds query and text the same way.
	words := strings.FieldsFunc(input, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	if len(words) > maxSearchTerms {
		words = words[:maxSearchTerms]
	}
	for i, w := range words {
		words[i] = w + ":*"
	}
	return strings.Join(words, " & ")
}

// Search handles GET /search?q=&channelId=&authorId=&limit=: newest matches first.
func (s *Service) Search(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	q := r.URL.Query()
	query := searchQuery(q.Get("q"))
	if query == "" {
		return httpx.Invalid(map[string]string{"q": "Type something to search for."})
	}
	limit := 20
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 50 {
			return httpx.Invalid(map[string]string{"limit": "Choose a limit between 1 and 50."})
		}
		limit = n
	}
	var channelID, authorID *uuid.UUID
	for key, dst := range map[string]**uuid.UUID{"channelId": &channelID, "authorId": &authorID} {
		if v := q.Get(key); v != "" {
			id, err := uuid.Parse(v)
			if err != nil {
				return httpx.Invalid(map[string]string{key: "Choose a valid filter."})
			}
			*dst = &id
		}
	}

	msgs, err := queryMessages(ctx, s.db, `
		JOIN channels c ON c.id = m.channel_id
		LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2 AND (cm.expires_at IS NULL OR cm.expires_at > now())
		WHERE m.org_id = $1 AND m.deleted_at IS NULL
		  AND m.search @@ to_tsquery('simple', $3)
		  AND (cm.user_id IS NOT NULL OR (c.kind = 'channel' AND c.visibility = 'public' AND $4))
		  AND ($5::uuid IS NULL OR m.channel_id = $5)
		  AND ($6::uuid IS NULL OR m.author_id = $6)
		ORDER BY m.id DESC
		LIMIT $7`, m.Org.ID, m.UserID, query, m.Can(org.PermChannelsJoin), channelID, authorID, limit)
	if err != nil {
		return err
	}
	if err := enrichMentions(ctx, s.db, msgs); err != nil {
		return err
	}
	if err := enrichAttachments(ctx, s.db, msgs); err != nil {
		return err
	}
	channelIDs := make([]uuid.UUID, 0, len(msgs))
	for _, msg := range msgs {
		channelIDs = append(channelIDs, msg.ChannelID)
	}
	chans, err := queryChannels(ctx, s.db, m.Org.ID, m.UserID, ` AND c.id = ANY ($3)`, unique(channelIDs))
	if err != nil {
		return err
	}
	byChannel := make(map[uuid.UUID]*Channel, len(chans))
	for i := range chans {
		byChannel[chans[i].ID] = &chans[i]
	}
	results := make([]SearchResult, 0, len(msgs))
	for _, msg := range msgs {
		results = append(results, SearchResult{Message: msg, Channel: byChannel[msg.ChannelID]})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"results": results})
	return nil
}
