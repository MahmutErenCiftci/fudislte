-- +goose Up

-- Instance-wide identities. Emails are stored normalized (trimmed, lower-case).
CREATE TABLE users (
    id                uuid PRIMARY KEY,
    email             text NOT NULL,
    display_name      text NOT NULL,
    password_hash     text NOT NULL,
    is_instance_admin boolean NOT NULL DEFAULT false,
    disabled_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_key UNIQUE (email),
    CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
    CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80)
);

-- Opaque session tokens; only SHA-256(token) is stored.
CREATE TABLE sessions (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL,
    user_agent   text NOT NULL DEFAULT '',
    ip_address   inet,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX sessions_active_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Tenant boundary. Every tenant-scoped table references organizations(id).
CREATE TABLE organizations (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    slug       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT organizations_slug_key UNIQUE (slug),
    CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
    CONSTRAINT organizations_name_length CHECK (char_length(name) BETWEEN 2 AND 80)
);

-- Per-organization roles. Higher position = more authority. The Owner role is a
-- system role and cannot be edited or deleted.
CREATE TABLE roles (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    key         text NOT NULL,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    position    integer NOT NULL,
    permissions text[] NOT NULL DEFAULT '{}',
    is_system   boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT roles_org_key_key UNIQUE (org_id, key),
    CONSTRAINT roles_org_name_key UNIQUE (org_id, name),
    CONSTRAINT roles_id_org_key UNIQUE (id, org_id),
    CONSTRAINT roles_position_range CHECK (position BETWEEN 0 AND 100),
    CONSTRAINT roles_name_length CHECK (char_length(name) BETWEEN 1 AND 40)
);

-- One role per member. The composite foreign key guarantees the role belongs to the
-- same organization as the membership.
CREATE TABLE memberships (
    org_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role_id   uuid NOT NULL,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id),
    CONSTRAINT memberships_role_fkey FOREIGN KEY (role_id, org_id) REFERENCES roles (id, org_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX memberships_role_idx ON memberships (role_id);

CREATE TABLE invitations (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email       text NOT NULL,
    role_id     uuid NOT NULL,
    token_hash  bytea NOT NULL,
    invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
    revoked_at  timestamptz,
    CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
    -- Deleting a role removes its historical invitations; pending ones block deletion in code.
    CONSTRAINT invitations_role_fkey FOREIGN KEY (role_id, org_id) REFERENCES roles (id, org_id) ON DELETE CASCADE,
    CONSTRAINT invitations_email_normalized CHECK (email = lower(btrim(email)))
);
CREATE UNIQUE INDEX invitations_pending_email_idx ON invitations (org_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Append-only audit trail. org_id is NULL for instance-level events such as sign-ins.
CREATE TABLE audit_events (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id        uuid REFERENCES organizations (id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    action        text NOT NULL,
    target_type   text NOT NULL DEFAULT '',
    target_id     text NOT NULL DEFAULT '',
    metadata      jsonb NOT NULL DEFAULT '{}',
    ip_address    inet,
    user_agent    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_idx ON audit_events (org_id, id DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, id DESC);

-- +goose Down
DROP TABLE audit_events;
DROP TABLE invitations;
DROP TABLE memberships;
DROP TABLE roles;
DROP TABLE organizations;
DROP TABLE sessions;
DROP TABLE users;
