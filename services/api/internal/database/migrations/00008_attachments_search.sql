-- +goose Up

-- Files sent with messages (ADR-0009). The bytes live on disk under the data directory;
-- message_id stays null until the uploader sends the message.
CREATE TABLE attachments (
    id           uuid PRIMARY KEY,
    org_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    channel_id   uuid NOT NULL,
    uploader_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    message_id   uuid REFERENCES messages (id) ON DELETE CASCADE,
    name         text NOT NULL,
    content_type text NOT NULL,
    size         bigint NOT NULL,
    sha256       bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attachments_channel_fkey FOREIGN KEY (channel_id, org_id) REFERENCES channels (id, org_id) ON DELETE CASCADE,
    CONSTRAINT attachments_name_length CHECK (char_length(name) BETWEEN 1 AND 255),
    CONSTRAINT attachments_size_positive CHECK (size > 0)
);
CREATE INDEX attachments_message_idx ON attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_channel_idx ON attachments (channel_id, created_at DESC) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_unsent_idx ON attachments (created_at) WHERE message_id IS NULL;

-- A message may consist of attachments only; the API requires text or files.
ALTER TABLE messages
    DROP CONSTRAINT messages_body_length,
    ADD CONSTRAINT messages_body_length CHECK (char_length(body) <= 4000);

-- Full-text search over message text. "simple" works for Turkish and English alike
-- (no stemming); mention tokens are left out.
ALTER TABLE messages ADD COLUMN search tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(body, '<@[0-9a-f-]+>', ' ', 'g'))) STORED;
CREATE INDEX messages_search_idx ON messages USING gin (search);

-- Workspace message retention in days (increment 2.6); null keeps messages forever.
ALTER TABLE organizations ADD COLUMN retention_days integer
    CONSTRAINT organizations_retention_range CHECK (retention_days BETWEEN 30 AND 3650);

-- +goose Down
ALTER TABLE organizations DROP COLUMN retention_days;
DROP INDEX messages_search_idx;
ALTER TABLE messages DROP COLUMN search;
DROP TABLE attachments;
DELETE FROM messages WHERE body = '' AND deleted_at IS NULL;
ALTER TABLE messages
    DROP CONSTRAINT messages_body_length,
    ADD CONSTRAINT messages_body_length
        CHECK (char_length(body) <= 4000 AND (deleted_at IS NOT NULL OR char_length(body) >= 1));
