-- +goose Up

-- Each person's preferred language for the UI and for emails sent to them.
ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'tr'
    CONSTRAINT users_locale_supported CHECK (locale IN ('tr', 'en'));

-- +goose Down
ALTER TABLE users DROP COLUMN locale;
