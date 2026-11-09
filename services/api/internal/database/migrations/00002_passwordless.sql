-- +goose Up

-- FUDISLTE signs people in with one-time codes sent to their work email (ADR-0006).
ALTER TABLE users DROP COLUMN password_hash;

-- Short-lived one-time codes. Only a salted SHA-256 of the code is stored.
CREATE TABLE email_codes (
    id          uuid PRIMARY KEY,
    email       text NOT NULL,
    purpose     text NOT NULL,
    code_hash   bytea NOT NULL,
    attempts    integer NOT NULL DEFAULT 0,
    ip_address  inet,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    CONSTRAINT email_codes_purpose_check CHECK (purpose IN ('login', 'setup', 'invitation')),
    CONSTRAINT email_codes_email_normalized CHECK (email = lower(btrim(email)))
);
CREATE INDEX email_codes_active_idx ON email_codes (email, purpose, created_at DESC) WHERE consumed_at IS NULL;

-- Email domains whose owners may join a workspace on first sign-in, with the role
-- they receive.
CREATE TABLE organization_domains (
    org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    domain     text NOT NULL,
    role_id    uuid NOT NULL,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, domain),
    CONSTRAINT organization_domains_role_fkey FOREIGN KEY (role_id, org_id) REFERENCES roles (id, org_id),
    CONSTRAINT organization_domains_format CHECK (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);
CREATE INDEX organization_domains_domain_idx ON organization_domains (domain);

-- +goose Down
DROP TABLE organization_domains;
DROP TABLE email_codes;
ALTER TABLE users ADD COLUMN password_hash text NOT NULL DEFAULT '';
