package chat

import (
	"context"

	"github.com/google/uuid"

	"fudislte/api/internal/database"
	"fudislte/api/internal/org"
)

// ChannelRef is what other modules — task links, whiteboards — may show of a channel or
// a room, and only to people who may see it.
type ChannelRef struct {
	ID   uuid.UUID `json:"id"`
	Kind string    `json:"kind"`
	Name string    `json:"name"`
	// Joined is set when m is a member of the channel or admitted to the room: only then
	// may they read its contents.
	Joined bool `json:"joined"`
}

// VisibleChannels returns, by ID, the channels and rooms among ids that m may see:
// channels they joined and public ones they may join, rooms they may enter or manage.
// The rules are the ones the channel and room endpoints apply; direct conversations
// are never included.
func VisibleChannels(ctx context.Context, q database.Querier, m *org.Membership, ids []uuid.UUID) (map[uuid.UUID]ChannelRef, error) {
	out := map[uuid.UUID]ChannelRef{}
	if len(ids) == 0 {
		return out, nil
	}
	chans, err := queryChannels(ctx, q, m.Org.ID, m.UserID, ` AND c.kind = 'channel' AND c.id = ANY ($3)`, unique(ids))
	if err != nil {
		return nil, err
	}
	for _, c := range chans {
		if c.visibleTo(m) {
			out[c.ID] = ChannelRef{ID: c.ID, Kind: KindChannel, Name: c.Name, Joined: c.Joined}
		}
	}
	rooms, err := queryRooms(ctx, q, m, ` AND c.id = ANY ($3)`, unique(ids))
	if err != nil {
		return nil, err
	}
	for _, rm := range rooms {
		if rm.visible() {
			out[rm.ID] = ChannelRef{ID: rm.ID, Kind: KindRoom, Name: rm.Name, Joined: rm.Admitted}
		}
	}
	return out, nil
}

// ChannelMembers returns the people who receive a channel's or an admitted room's
// events now.
func ChannelMembers(ctx context.Context, q database.Querier, channelID uuid.UUID) ([]uuid.UUID, error) {
	return memberIDs(ctx, q, channelID)
}
