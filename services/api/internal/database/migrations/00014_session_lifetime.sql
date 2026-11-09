-- +goose Up

-- Server-wide settings that instance administrators change at runtime. Exactly one row.
CREATE TABLE instance_settings (
    id                boolean PRIMARY KEY DEFAULT true,
    -- How long a sign-in lasts before people must sign in again (absolute, not sliding).
    session_ttl_hours integer NOT NULL DEFAULT 48,
    updated_by        uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT instance_settings_single_row CHECK (id),
    CONSTRAINT instance_settings_session_ttl_range CHECK (session_ttl_hours BETWEEN 1 AND 2160)
);
INSERT INTO instance_settings DEFAULT VALUES;

-- Sessions follow the lifetime in force, so the 48-hour default applies to existing ones.
UPDATE sessions SET expires_at = created_at + interval '48 hours'
WHERE revoked_at IS NULL AND expires_at > created_at + interval '48 hours';

-- +goose Down
DROP TABLE instance_settings;
