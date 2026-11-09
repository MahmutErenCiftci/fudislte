-- +goose Up

-- Email domains join people automatically only after the workspace proves it controls
-- the domain with a DNS TXT record (docs/architecture/phase-1x.md). Domains added before
-- verification existed were trusted by an administrator and stay verified.
ALTER TABLE organization_domains
    ADD COLUMN verification_token text,
    ADD COLUMN verified_at timestamptz;
UPDATE organization_domains
SET verification_token = replace(gen_random_uuid()::text, '-', ''), verified_at = created_at;
ALTER TABLE organization_domains ALTER COLUMN verification_token SET NOT NULL;

-- +goose Down
ALTER TABLE organization_domains DROP COLUMN verified_at, DROP COLUMN verification_token;
