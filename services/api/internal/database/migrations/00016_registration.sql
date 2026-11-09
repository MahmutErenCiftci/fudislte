-- +goose Up

-- Opt-in registration with the FUDISLTE project (docs/deployment/registry.md). When an
-- instance administrator agrees, the server reports the organization name and contact
-- email they entered, its number of users and its version, once a day. Off by default.
ALTER TABLE instance_settings
    ADD COLUMN instance_id            uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN registration_enabled   boolean NOT NULL DEFAULT false,
    ADD COLUMN registration_name      text NOT NULL DEFAULT '',
    ADD COLUMN registration_email     text NOT NULL DEFAULT '',
    -- Proves to the registry that later reports and the withdrawal come from this server.
    ADD COLUMN registration_secret    text NOT NULL DEFAULT '',
    -- Set while the registry may hold this server's record; cleared once it is withdrawn.
    ADD COLUMN registration_sent_at   timestamptz,
    ADD COLUMN registration_error     text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE instance_settings
    DROP COLUMN registration_error,
    DROP COLUMN registration_sent_at,
    DROP COLUMN registration_secret,
    DROP COLUMN registration_email,
    DROP COLUMN registration_name,
    DROP COLUMN registration_enabled,
    DROP COLUMN instance_id;
