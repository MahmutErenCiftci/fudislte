-- +goose Up

-- Deleting a message or a channel cascades to its notifications. The unique constraint
-- (user_id, message_id) cannot serve those lookups, so without these indexes every such
-- delete scanned the whole notifications table.
CREATE INDEX notifications_message_idx ON notifications (message_id);
CREATE INDEX notifications_channel_idx ON notifications (channel_id);

-- Retention finds a workspace's messages older than its cutoff.
CREATE INDEX messages_org_created_idx ON messages (org_id, created_at);

-- +goose Down
DROP INDEX messages_org_created_idx;
DROP INDEX notifications_channel_idx;
DROP INDEX notifications_message_idx;
