-- +goose Up

-- Threads (one level), placeholders for deleted thread roots, and pins
-- (docs/architecture/phase-2.md). A reply's root is in the same channel: the composite
-- foreign key below guarantees it.
ALTER TABLE messages
    ADD COLUMN parent_id uuid,
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN pinned_at timestamptz,
    ADD COLUMN pinned_by uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD CONSTRAINT messages_id_channel_key UNIQUE (id, channel_id),
    ADD CONSTRAINT messages_parent_fkey FOREIGN KEY (parent_id, channel_id)
        REFERENCES messages (id, channel_id) ON DELETE CASCADE,
    DROP CONSTRAINT messages_body_length,
    ADD CONSTRAINT messages_body_length
        CHECK (char_length(body) <= 4000 AND (deleted_at IS NOT NULL OR char_length(body) >= 1)),
    ADD CONSTRAINT messages_deleted_unpinned CHECK (deleted_at IS NULL OR pinned_at IS NULL);
CREATE INDEX messages_thread_idx ON messages (parent_id, id) WHERE parent_id IS NOT NULL;
CREATE INDEX messages_pinned_idx ON messages (channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

CREATE TABLE message_reactions (
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    emoji      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji),
    CONSTRAINT message_reactions_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 16)
);

-- Who a message mentions; read by notifications (increment 2.4).
CREATE TABLE message_mentions (
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user_idx ON message_mentions (user_id, message_id DESC);

-- +goose Down
DROP TABLE message_mentions;
DROP TABLE message_reactions;
DELETE FROM messages WHERE parent_id IS NOT NULL OR deleted_at IS NOT NULL;
DROP INDEX messages_pinned_idx;
DROP INDEX messages_thread_idx;
ALTER TABLE messages
    DROP CONSTRAINT messages_deleted_unpinned,
    DROP CONSTRAINT messages_body_length,
    ADD CONSTRAINT messages_body_length CHECK (char_length(body) BETWEEN 1 AND 4000),
    DROP CONSTRAINT messages_parent_fkey,
    DROP CONSTRAINT messages_id_channel_key,
    DROP COLUMN pinned_by,
    DROP COLUMN pinned_at,
    DROP COLUMN deleted_at,
    DROP COLUMN parent_id;
