-- +goose Up

-- Workspace chat channels (docs/architecture/phase-2.md). Names are validated and
-- normalized in Go; the checks here are a last line of defence.
CREATE TABLE channels (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name        text NOT NULL,
    topic       text NOT NULL DEFAULT '',
    visibility  text NOT NULL,
    is_default  boolean NOT NULL DEFAULT false,
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT channels_id_org_key UNIQUE (id, org_id),
    CONSTRAINT channels_visibility_check CHECK (visibility IN ('public', 'private')),
    CONSTRAINT channels_default_public CHECK (NOT is_default OR visibility = 'public'),
    CONSTRAINT channels_name_format CHECK (char_length(name) BETWEEN 1 AND 40 AND name !~ '\s'),
    CONSTRAINT channels_topic_length CHECK (char_length(topic) <= 250)
);
CREATE UNIQUE INDEX channels_org_name_key ON channels (org_id, name);
CREATE UNIQUE INDEX channels_org_default_key ON channels (org_id) WHERE is_default;

-- Referencing memberships means leaving a workspace removes its channel memberships.
CREATE TABLE channel_members (
    channel_id   uuid NOT NULL,
    org_id       uuid NOT NULL,
    user_id      uuid NOT NULL,
    joined_at    timestamptz NOT NULL DEFAULT now(),
    last_read_id uuid,
    PRIMARY KEY (channel_id, user_id),
    CONSTRAINT channel_members_channel_fkey FOREIGN KEY (channel_id, org_id)
        REFERENCES channels (id, org_id) ON DELETE CASCADE,
    CONSTRAINT channel_members_membership_fkey FOREIGN KEY (org_id, user_id)
        REFERENCES memberships (org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX channel_members_user_idx ON channel_members (org_id, user_id);

-- Message IDs are UUIDv7, so ID order is time order; it is the pagination cursor and
-- the unread marker.
CREATE TABLE messages (
    id         uuid PRIMARY KEY,
    org_id     uuid NOT NULL,
    channel_id uuid NOT NULL,
    author_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at  timestamptz,
    CONSTRAINT messages_channel_fkey FOREIGN KEY (channel_id, org_id)
        REFERENCES channels (id, org_id) ON DELETE CASCADE,
    CONSTRAINT messages_body_length CHECK (char_length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX messages_channel_idx ON messages (channel_id, id DESC);

-- New members join the default channel when their role may join public channels. A
-- trigger covers every way of joining a workspace (setup, invitation, email domain).
-- +goose StatementBegin
CREATE FUNCTION join_default_channels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO channel_members (channel_id, org_id, user_id, last_read_id)
    SELECT c.id, c.org_id, NEW.user_id,
           (SELECT m.id FROM messages m WHERE m.channel_id = c.id ORDER BY m.id DESC LIMIT 1)
    FROM channels c
    WHERE c.org_id = NEW.org_id AND c.is_default AND c.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM roles r WHERE r.id = NEW.role_id AND 'channels.join' = ANY (r.permissions))
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER memberships_join_default_channels AFTER INSERT ON memberships
    FOR EACH ROW EXECUTE FUNCTION join_default_channels();

-- Existing workspaces: grant the new permissions like the default role templates do
-- (custom roles get join and create; administrators may adjust), then create the
-- default channel and add everyone who may join it.
UPDATE roles SET permissions = permissions || ARRAY['channels.join', 'channels.create']
WHERE key <> 'guest';
UPDATE roles SET permissions = permissions || ARRAY['channels.manage', 'messages.manage']
WHERE key IN ('owner', 'administrator');

INSERT INTO channels (id, org_id, name, visibility, is_default)
SELECT gen_random_uuid(), o.id, 'genel', 'public', true FROM organizations o;

INSERT INTO channel_members (channel_id, org_id, user_id)
SELECT c.id, m.org_id, m.user_id
FROM channels c
JOIN memberships m ON m.org_id = c.org_id
JOIN roles r ON r.id = m.role_id
WHERE c.is_default AND 'channels.join' = ANY (r.permissions);

-- +goose Down
DROP TRIGGER memberships_join_default_channels ON memberships;
DROP FUNCTION join_default_channels();
DROP TABLE messages;
DROP TABLE channel_members;
DROP TABLE channels;
UPDATE roles SET permissions = ARRAY(
    SELECT p FROM unnest(permissions) AS p
    WHERE p NOT IN ('channels.join', 'channels.create', 'channels.manage', 'messages.manage'));
