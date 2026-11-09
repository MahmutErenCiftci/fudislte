// Package chat implements workspace channels and messages (docs/architecture/phase-2.md).
// Every handler runs behind org.RequireMember; channels the caller may not see answer
// 404 so their existence is not disclosed.
package chat

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/mail"
	"fudislte/api/internal/media"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
	"fudislte/api/internal/storage"
)

type Service struct {
	db          *pgxpool.Pool
	events      realtime.Publisher
	files       storage.Store
	maxUpload   int64
	postsByUser *httpx.Limiter
	// reactionsByUser is more generous: people react in quick bursts.
	reactionsByUser *httpx.Limiter
	typingByUser    *httpx.Limiter
	uploadsByUser   *httpx.Limiter
	// roomAttempts limits room password guesses per person and room.
	roomAttempts *httpx.Limiter
	// meetingWrites limits meeting changes per person: each one may email every invitee.
	meetingWrites *httpx.Limiter
	// media is the LiveKit server for voice and video; nil or unconfigured disables them.
	media *media.Service
	// outbox sends meeting invitations; links in them start with publicURL.
	outbox    *mail.Outbox
	publicURL string
}

func NewService(db *pgxpool.Pool, events realtime.Publisher, files storage.Store, maxUpload int64) *Service {
	return &Service{
		db:              db,
		events:          events,
		files:           files,
		maxUpload:       maxUpload,
		postsByUser:     httpx.NewLimiter(200*time.Millisecond, 20),
		reactionsByUser: httpx.NewLimiter(100*time.Millisecond, 40),
		typingByUser:    httpx.NewLimiter(time.Second, 3),
		uploadsByUser:   httpx.NewLimiter(2*time.Second, 20),
		roomAttempts:    httpx.NewLimiter(time.Minute, 5),
		meetingWrites:   httpx.NewLimiter(3*time.Second, 20),
	}
}

const (
	VisibilityPublic  = "public"
	VisibilityPrivate = "private"

	KindChannel = "channel"
	KindDirect  = "direct"
	KindRoom    = "room"
)

type Channel struct {
	ID   uuid.UUID `json:"id"`
	Kind string    `json:"kind"`
	// Name is empty for direct conversations; clients name them after the participants.
	Name       string     `json:"name"`
	Topic      string     `json:"topic"`
	Visibility string     `json:"visibility"`
	IsDefault  bool       `json:"isDefault"`
	CreatedBy  *uuid.UUID `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	// ArchivedAt is set on archived channels, which are read-only.
	ArchivedAt  *time.Time `json:"archivedAt,omitempty"`
	MemberCount int        `json:"memberCount"`
	// Joined, LastReadID and UnreadCount describe the caller's membership.
	Joined      bool       `json:"joined"`
	LastReadID  *uuid.UUID `json:"lastReadId"`
	UnreadCount int        `json:"unreadCount"`
	// Participants of a direct conversation, the caller included, by name.
	Participants []Author `json:"participants,omitempty"`
	// LastMessage is filled in conversation lists.
	LastMessage *Message `json:"lastMessage,omitempty"`

	participantIDs []uuid.UUID
}

func (c *Channel) isDirect() bool { return c.Kind == KindDirect }

// fixedMembership rejects the channel endpoints that change people or names for direct
// conversations and rooms, which have their own rules.
func (c *Channel) fixedMembership() error {
	switch c.Kind {
	case KindDirect:
		return errFixedMembers
	case KindRoom:
		return errRoomManaged
	}
	return nil
}

// channelQuery loads channels with the caller's ($2) membership. Unread counts stop at
// 100; clients show "99+".
const channelQuery = `
	SELECT c.id, c.kind, coalesce(c.name, ''), c.topic, c.visibility, c.is_default, c.created_by, c.created_at, c.archived_at, c.participants,
	       (SELECT count(*) FROM channel_members x WHERE x.channel_id = c.id AND (x.expires_at IS NULL OR x.expires_at > now())),
	       cm.user_id IS NOT NULL, cm.last_read_id,
	       CASE WHEN cm.user_id IS NULL THEN 0 ELSE (
	           SELECT count(*) FROM (
	               SELECT 1 FROM messages msg
	               WHERE msg.channel_id = c.id AND msg.parent_id IS NULL AND msg.deleted_at IS NULL
	                 AND (cm.last_read_id IS NULL OR msg.id > cm.last_read_id)
	                 AND msg.author_id IS DISTINCT FROM $2
	               LIMIT 100) unread) END
	FROM channels c
	LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2 AND (cm.expires_at IS NULL OR cm.expires_at > now())
	WHERE c.org_id = $1`

func scanChannel(row pgx.Row) (Channel, error) {
	var c Channel
	err := row.Scan(&c.ID, &c.Kind, &c.Name, &c.Topic, &c.Visibility, &c.IsDefault, &c.CreatedBy, &c.CreatedAt, &c.ArchivedAt, &c.participantIDs,
		&c.MemberCount, &c.Joined, &c.LastReadID, &c.UnreadCount)
	return c, err
}

func queryChannels(ctx context.Context, q database.Querier, orgID, userID uuid.UUID, filter string, args ...any) ([]Channel, error) {
	rows, err := q.Query(ctx, channelQuery+filter, append([]any{orgID, userID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Channel{}
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, fillParticipants(ctx, q, out)
}

// fillParticipants names the participants of direct conversations.
func fillParticipants(ctx context.Context, q database.Querier, chans []Channel) error {
	var ids []uuid.UUID
	for _, c := range chans {
		ids = append(ids, c.participantIDs...)
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `SELECT id, display_name FROM users WHERE id = ANY ($1)`, unique(ids))
	if err != nil {
		return err
	}
	names, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Author, error) {
		var a Author
		err := row.Scan(&a.ID, &a.DisplayName)
		return a, err
	})
	if err != nil {
		return err
	}
	byID := make(map[uuid.UUID]Author, len(names))
	for _, a := range names {
		byID[a.ID] = a
	}
	for i := range chans {
		if len(chans[i].participantIDs) == 0 {
			continue
		}
		ps := make([]Author, 0, len(chans[i].participantIDs))
		for _, id := range chans[i].participantIDs {
			ps = append(ps, byID[id])
		}
		slices.SortFunc(ps, func(a, b Author) int {
			return strings.Compare(strings.ToLower(a.DisplayName), strings.ToLower(b.DisplayName))
		})
		chans[i].Participants = ps
	}
	return nil
}

// visibleTo reports whether m may see the channel: members always, and anyone who may
// join public channels for public ones.
func (c *Channel) visibleTo(m *org.Membership) bool {
	return c.Joined || (c.Visibility == VisibilityPublic && m.Can(org.PermChannelsJoin))
}

// canManage reports whether m may rename the channel and remove its members.
func (c *Channel) canManage(m *org.Membership) bool {
	return m.Can(org.PermChannelsManage) || (c.CreatedBy != nil && *c.CreatedBy == m.UserID)
}

// loadChannel returns the channel channelID of the caller's workspace if the caller may
// see it, and httpx.ErrNotFound otherwise.
func loadChannel(ctx context.Context, q database.Querier, m *org.Membership, channelID uuid.UUID) (*Channel, error) {
	chans, err := queryChannels(ctx, q, m.Org.ID, m.UserID, ` AND c.id = $3`, channelID)
	if err != nil {
		return nil, err
	}
	if len(chans) == 0 || !chans[0].visibleTo(m) {
		return nil, httpx.ErrNotFound
	}
	return &chans[0], nil
}

// channelFromRequest loads the {channelID} channel for the calling member.
func channelFromRequest(r *http.Request, q database.Querier) (*org.Membership, *Channel, error) {
	m := org.MembershipFrom(r.Context())
	channelID, err := uuid.Parse(chi.URLParam(r, "channelID"))
	if err != nil {
		return m, nil, httpx.ErrNotFound
	}
	c, err := loadChannel(r.Context(), q, m, channelID)
	return m, c, err
}

func identity(ctx context.Context) *auth.Identity { return auth.MustIdentity(ctx) }

// memberIDs returns the users who receive the channel's events.
func memberIDs(ctx context.Context, q database.Querier, channelID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx, `SELECT user_id FROM channel_members WHERE channel_id = $1 AND (expires_at IS NULL OR expires_at > now())`, channelID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// publishToMembers sends ev to the channel's current members. Call it after the change
// has committed; a failure only delays clients until their next refetch.
func (s *Service) publishToMembers(ctx context.Context, channelID uuid.UUID, ev realtime.Event) {
	ids, err := memberIDs(ctx, s.db, channelID)
	if err != nil {
		return
	}
	s.events.Publish(ids, ev)
}

// publishMembership tells the channel's members its new member count after people
// joined or left.
func (s *Service) publishMembership(ctx context.Context, orgID, channelID uuid.UUID) {
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM channel_members WHERE channel_id = $1 AND (expires_at IS NULL OR expires_at > now())`, channelID).Scan(&count); err != nil {
		return
	}
	s.publishToMembers(ctx, channelID, realtime.Event{Type: "channel.members", Data: map[string]any{
		"orgId": orgID, "channelId": channelID, "memberCount": count,
	}})
}

// NormalizeChannelName turns user input such as "Müşteri Destek" into a channel name
// ("müşteri-destek"), returning a user-facing message when it cannot.
func NormalizeChannelName(s string) (string, string) {
	// strings.ToLower turns the Turkish dotted capital İ into i plus a combining dot.
	s = strings.TrimPrefix(strings.TrimSpace(s), "#")
	s = strings.ToLower(strings.ReplaceAll(s, "İ", "i"))
	var b strings.Builder
	dash := false
	for _, r := range s {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_':
			b.WriteRune(r)
			dash = false
		case (r == '-' || unicode.IsSpace(r) || r == '.') && !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		case unicode.IsMark(r), r == '-', unicode.IsSpace(r), r == '.':
			// Combining marks and repeated separators are dropped.
		default:
			return "", "Use letters, digits, dashes and underscores."
		}
	}
	name := strings.TrimRight(b.String(), "-")
	if n := utf8.RuneCountInString(name); n < 1 || n > 40 {
		return "", "Use 1 to 40 characters."
	}
	return name, ""
}

// normalizeTopic collapses whitespace into a single line of at most 250 characters.
func normalizeTopic(s string) (string, string) {
	s = strings.Join(strings.FieldsFunc(s, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	if utf8.RuneCountInString(s) > 250 {
		return "", "Use at most 250 characters."
	}
	return s, ""
}

const maxMessageLength = 4000

// normalizeBody keeps line breaks and tabs, drops other control characters and trims
// surrounding blank space.
func normalizeBody(s string) (string, string) {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, s)
	s = strings.TrimSpace(s)
	switch n := utf8.RuneCountInString(s); {
	case n == 0:
		return "", "Write a message."
	case n > maxMessageLength:
		return "", "Messages can be at most 4000 characters."
	}
	return s, ""
}

var errNotMember = httpx.NewError(http.StatusForbidden, "not_channel_member", "Join the channel first.")

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
