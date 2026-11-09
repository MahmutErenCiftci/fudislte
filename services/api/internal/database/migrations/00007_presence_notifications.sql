-- +goose Up

-- A person's chosen status (docs/architecture/phase-2.md, increment 2.4). Online/away
-- presence is not stored: it comes from the live event streams.
ALTER TABLE users
    ADD COLUMN status_kind text NOT NULL DEFAULT '',
    ADD COLUMN status_text text NOT NULL DEFAULT '',
    ADD COLUMN status_expires_at timestamptz,
    ADD COLUMN status_mute boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT users_status_kind_check CHECK (status_kind IN ('', 'meeting', 'coding', 'focus', 'call', 'custom')),
    ADD CONSTRAINT users_status_text_length CHECK (char_length(status_text) <= 100);

-- Mentions and thread replies addressed to one person.
CREATE TABLE notifications (
    id         uuid PRIMARY KEY,
    org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind       text NOT NULL,
    channel_id uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at    timestamptz,
    CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply')),
    CONSTRAINT notifications_once UNIQUE (user_id, message_id)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, org_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id, org_id) WHERE read_at IS NULL;

-- +goose Down
DROP TABLE notifications;
ALTER TABLE users
    DROP CONSTRAINT users_status_text_length,
    DROP CONSTRAINT users_status_kind_check,
    DROP COLUMN status_mute,
    DROP COLUMN status_expires_at,
    DROP COLUMN status_text,
    DROP COLUMN status_kind;
