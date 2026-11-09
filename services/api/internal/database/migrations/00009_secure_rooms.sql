-- +goose Up

-- Secure rooms (docs/architecture/phase-3.md, ADR-0010) are channels of kind 'room', so
-- messages, files, read markers, search and live events work as in channels. Being in
-- channel_members is being admitted; a password admission expires.
ALTER TABLE channels
    ADD COLUMN access text,
    ADD COLUMN password_hash text,
    ADD COLUMN password_changed_at timestamptz,
    ADD COLUMN admission_minutes integer,
    DROP CONSTRAINT channels_kind_check,
    ADD CONSTRAINT channels_kind_check CHECK (
        (kind = 'channel' AND name IS NOT NULL AND participants IS NULL AND access IS NULL)
        OR (kind = 'direct' AND name IS NULL AND visibility = 'private' AND NOT is_default
            AND cardinality(participants) BETWEEN 1 AND 9 AND access IS NULL)
        OR (kind = 'room' AND name IS NOT NULL AND visibility = 'private' AND NOT is_default
            AND participants IS NULL AND access IS NOT NULL AND admission_minutes IS NOT NULL)),
    ADD CONSTRAINT channels_room_access_check CHECK (
        access IS NULL
        OR (access = 'open' AND password_hash IS NULL)
        OR (access = 'protected' AND password_hash IS NOT NULL)
        OR access = 'restricted'),
    ADD CONSTRAINT channels_admission_minutes_check CHECK (admission_minutes BETWEEN 15 AND 43200),
    DROP CONSTRAINT channels_name_format,
    ADD CONSTRAINT channels_name_format CHECK (
        (kind <> 'channel' OR (char_length(name) BETWEEN 1 AND 40 AND name !~ '\s'))
        AND (kind <> 'room' OR char_length(name) BETWEEN 1 AND 60));

DROP INDEX channels_org_name_key;
CREATE UNIQUE INDEX channels_org_name_key ON channels (org_id, name) WHERE kind = 'channel';
CREATE UNIQUE INDEX channels_room_name_key ON channels (org_id, lower(name)) WHERE kind = 'room';

-- A password admission lasts until expires_at; NULL is a lasting membership.
ALTER TABLE channel_members ADD COLUMN expires_at timestamptz;
CREATE INDEX channel_members_expiry_idx ON channel_members (expires_at) WHERE expires_at IS NOT NULL;

-- Who may enter a restricted room. Leaving the workspace removes the entry.
CREATE TABLE room_access (
    channel_id uuid NOT NULL,
    org_id     uuid NOT NULL,
    user_id    uuid NOT NULL,
    added_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id),
    CONSTRAINT room_access_channel_fkey FOREIGN KEY (channel_id, org_id)
        REFERENCES channels (id, org_id) ON DELETE CASCADE,
    CONSTRAINT room_access_membership_fkey FOREIGN KEY (org_id, user_id)
        REFERENCES memberships (org_id, user_id) ON DELETE CASCADE
);

-- Default roles: everyone but guests enters and creates rooms; owners, administrators
-- and security administrators manage every room's security.
UPDATE roles SET permissions = permissions || ARRAY['rooms.join', 'rooms.create']
WHERE key <> 'guest';
UPDATE roles SET permissions = permissions || ARRAY['rooms.manage']
WHERE key IN ('owner', 'administrator', 'security-administrator');

-- +goose Down
UPDATE roles SET permissions = ARRAY(
    SELECT p FROM unnest(permissions) AS p
    WHERE p NOT IN ('rooms.join', 'rooms.create', 'rooms.manage'));
DROP TABLE room_access;
DROP INDEX channel_members_expiry_idx;
ALTER TABLE channel_members DROP COLUMN expires_at;
DELETE FROM channels WHERE kind = 'room';
DROP INDEX channels_room_name_key;
DROP INDEX channels_org_name_key;
CREATE UNIQUE INDEX channels_org_name_key ON channels (org_id, name);
ALTER TABLE channels
    DROP CONSTRAINT channels_name_format,
    ADD CONSTRAINT channels_name_format CHECK (char_length(name) BETWEEN 1 AND 40 AND name !~ '\s'),
    DROP CONSTRAINT channels_admission_minutes_check,
    DROP CONSTRAINT channels_room_access_check,
    DROP CONSTRAINT channels_kind_check,
    ADD CONSTRAINT channels_kind_check CHECK (
        (kind = 'channel' AND name IS NOT NULL AND participants IS NULL)
        OR (kind = 'direct' AND name IS NULL AND visibility = 'private' AND NOT is_default
            AND cardinality(participants) BETWEEN 1 AND 9)),
    DROP COLUMN admission_minutes,
    DROP COLUMN password_changed_at,
    DROP COLUMN password_hash,
    DROP COLUMN access;
