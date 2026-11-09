-- +goose Up

-- Access keys: an administrator prepares a person's account — email, name, role and
-- language — and hands them a single-use key. Entering the key creates the account and
-- signs it in without an email code. Only SHA-256 of the normalized key is stored.
CREATE TABLE access_keys (
    id           uuid PRIMARY KEY,
    org_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email        text NOT NULL,
    display_name text NOT NULL,
    locale       text NOT NULL,
    role_id      uuid NOT NULL,
    key_hash     bytea NOT NULL,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    used_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    revoked_at   timestamptz,
    CONSTRAINT access_keys_key_hash_key UNIQUE (key_hash),
    -- Deleting a role removes its historical keys; pending ones block deletion in code.
    CONSTRAINT access_keys_role_fkey FOREIGN KEY (role_id, org_id) REFERENCES roles (id, org_id) ON DELETE CASCADE,
    CONSTRAINT access_keys_email_normalized CHECK (email = lower(btrim(email))),
    CONSTRAINT access_keys_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80),
    CONSTRAINT access_keys_locale_check CHECK (locale IN ('tr', 'en'))
);
-- A new key for the same person supersedes the pending one.
CREATE UNIQUE INDEX access_keys_pending_email_idx ON access_keys (org_id, email)
    WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX access_keys_role_idx ON access_keys (role_id);

-- +goose Down
DROP TABLE access_keys;
