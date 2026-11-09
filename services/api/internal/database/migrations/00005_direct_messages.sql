-- +goose Up

-- Direct conversations are channels of kind 'direct' (docs/architecture/phase-2.md): no
-- name, private, and a fixed sorted set of participants, so messages, read markers and
-- live events work exactly as in channels.
ALTER TABLE channels
    ADD COLUMN kind text NOT NULL DEFAULT 'channel',
    ADD COLUMN participants uuid[],
    ALTER COLUMN name DROP NOT NULL,
    ADD CONSTRAINT channels_kind_check CHECK (
        (kind = 'channel' AND name IS NOT NULL AND participants IS NULL)
        OR (kind = 'direct' AND name IS NULL AND visibility = 'private' AND NOT is_default
            AND cardinality(participants) BETWEEN 1 AND 9));

-- One conversation per set of people.
CREATE UNIQUE INDEX channels_direct_key ON channels (org_id, participants) WHERE kind = 'direct';

-- +goose Down
DELETE FROM channels WHERE kind = 'direct';
DROP INDEX channels_direct_key;
ALTER TABLE channels
    DROP CONSTRAINT channels_kind_check,
    ALTER COLUMN name SET NOT NULL,
    DROP COLUMN participants,
    DROP COLUMN kind;
