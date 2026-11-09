-- +goose Up

-- Scheduled voice and video meetings with invitations (docs/architecture/phase-4.md).
-- Only the organizer and the invitees may join, from 15 minutes before the start until
-- 2 hours after the scheduled end; the LiveKit room is "fudislte-meeting-<id>". Titles,
-- agendas and times are validated in Go; the checks here are a last line of defence.
CREATE TABLE meetings (
    id               uuid PRIMARY KEY,
    org_id           uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    title            text NOT NULL,
    agenda           text NOT NULL DEFAULT '',
    starts_at        timestamptz NOT NULL,
    duration_minutes integer NOT NULL,
    -- The organizer's IANA time zone, used to write times in emails.
    time_zone        text NOT NULL DEFAULT 'UTC',
    -- NULL once the organizer has left the workspace: the meeting stays for its invitees.
    organizer_id     uuid,
    -- Calendar invitations carry it (iCalendar SEQUENCE): it grows with every new time
    -- and with the cancellation, so calendars replace older copies.
    sequence         integer NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    canceled_at      timestamptz,
    CONSTRAINT meetings_id_org_key UNIQUE (id, org_id),
    CONSTRAINT meetings_organizer_fkey FOREIGN KEY (org_id, organizer_id)
        REFERENCES memberships (org_id, user_id) ON DELETE SET NULL (organizer_id),
    CONSTRAINT meetings_title_length CHECK (char_length(title) BETWEEN 1 AND 120),
    CONSTRAINT meetings_agenda_length CHECK (char_length(agenda) <= 2000),
    CONSTRAINT meetings_duration_range CHECK (duration_minutes BETWEEN 15 AND 480),
    CONSTRAINT meetings_time_zone_length CHECK (char_length(time_zone) BETWEEN 1 AND 64),
    CONSTRAINT meetings_sequence_check CHECK (sequence >= 0)
);
CREATE INDEX meetings_organizer_idx ON meetings (org_id, organizer_id);

-- Who is invited. Leaving the workspace removes the invitation.
CREATE TABLE meeting_invitees (
    meeting_id uuid NOT NULL,
    org_id     uuid NOT NULL,
    user_id    uuid NOT NULL,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, user_id),
    CONSTRAINT meeting_invitees_meeting_fkey FOREIGN KEY (meeting_id, org_id)
        REFERENCES meetings (id, org_id) ON DELETE CASCADE,
    CONSTRAINT meeting_invitees_membership_fkey FOREIGN KEY (org_id, user_id)
        REFERENCES memberships (org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX meeting_invitees_user_idx ON meeting_invitees (org_id, user_id);

-- Default roles: everyone but guests schedules meetings. Anyone may be invited.
UPDATE roles SET permissions = permissions || ARRAY['meetings.create']
WHERE key <> 'guest';

-- +goose Down
UPDATE roles SET permissions = ARRAY(
    SELECT p FROM unnest(permissions) AS p WHERE p <> 'meetings.create');
DROP TABLE meeting_invitees;
DROP TABLE meetings;
