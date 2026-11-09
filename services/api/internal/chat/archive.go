package chat

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
	"fudislte/api/internal/storage"
)

// Channel administration (increment 2.6): archiving and workspace message retention.

var (
	errArchived       = httpx.NewError(http.StatusConflict, "channel_archived", "This channel is archived. Restore it to post again.")
	errArchiveDefault = httpx.NewError(http.StatusConflict, "default_channel", "The default channel cannot be archived.")
)

// writableBy reports why the caller may not add to or change the channel's content.
func (c *Channel) writableBy() error {
	if !c.Joined {
		return errNotMember
	}
	if c.ArchivedAt != nil {
		return errArchived
	}
	return nil
}

// ArchiveChannel makes a channel read-only and takes it off the sidebar; its history
// and files stay.
func (s *Service) ArchiveChannel(w http.ResponseWriter, r *http.Request) error {
	return s.setArchived(w, r, true)
}

func (s *Service) UnarchiveChannel(w http.ResponseWriter, r *http.Request) error {
	return s.setArchived(w, r, false)
}

func (s *Service) setArchived(w http.ResponseWriter, r *http.Request, archive bool) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	switch {
	case c.Kind != KindChannel:
		return c.fixedMembership()
	case !c.canManage(m):
		return httpx.ErrForbidden
	case archive && c.IsDefault:
		return errArchiveDefault
	}
	if archive != (c.ArchivedAt != nil) {
		err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE channels SET archived_at = CASE WHEN $2 THEN now() END WHERE id = $1`, c.ID, archive); err != nil {
				return err
			}
			action := "channel.unarchived"
			if archive {
				action = "channel.archived"
			}
			ev := audit.FromRequest(r, action)
			ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
			ev.TargetType, ev.TargetID = "channel", c.ID.String()
			ev.Metadata = map[string]any{"channel": c.Name}
			return audit.Record(ctx, tx, ev)
		})
		if err != nil {
			return err
		}
		s.publishToMembers(ctx, c.ID, realtime.Event{Type: "channel.archived", Data: map[string]any{
			"orgId": m.Org.ID, "channelId": c.ID, "archived": archive,
		}})
	}
	c, err = loadChannel(ctx, s.db, m, c.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"channel": c})
	return nil
}

// GetRetention returns the workspace's message retention in days; null keeps messages.
func (s *Service) GetRetention(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	var days *int
	if err := s.db.QueryRow(r.Context(), `SELECT retention_days FROM organizations WHERE id = $1`, m.Org.ID).Scan(&days); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"days": days})
	return nil
}

// SetRetention sets {"days": 30–3650} or {"days": null} to keep messages forever.
func (s *Service) SetRetention(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	var in struct {
		Days *int `json:"days"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Days != nil && (*in.Days < 30 || *in.Days > 3650) {
		return httpx.Invalid(map[string]string{"days": "Choose between 30 and 3650 days."})
	}
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var before *int
		if err := tx.QueryRow(ctx, `SELECT retention_days FROM organizations WHERE id = $1 FOR UPDATE`, m.Org.ID).Scan(&before); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE organizations SET retention_days = $2, updated_at = now() WHERE id = $1`, m.Org.ID, in.Days); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "org.retention_changed")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.Metadata = map[string]any{"retentionDays": map[string]any{"from": before, "to": in.Days}}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"days": in.Days})
	return nil
}

// Janitor removes what workspaces no longer keep: messages past their retention, and
// uploads that were never sent. Run it every interval until ctx ends.
func Janitor(ctx context.Context, db *pgxpool.Pool, files storage.Store, every time.Duration) {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if err := ApplyRetention(ctx, db, files, time.Now()); err != nil && ctx.Err() == nil {
				slog.Error("chat: retention", "error", err)
			}
			timer.Reset(every)
		}
	}
}

// ApplyRetention deletes, as of now, unsent uploads older than a day and messages older
// than each workspace's retention. A thread root that still has newer replies stays as a
// "deleted" placeholder, as when someone deletes it.
func ApplyRetention(ctx context.Context, db *pgxpool.Pool, files storage.Store, now time.Time) error {
	rows, err := db.Query(ctx, `DELETE FROM attachments WHERE message_id IS NULL AND created_at < $1 RETURNING org_id, id`,
		now.Add(-unsentAttachmentTTL))
	if err != nil {
		return err
	}
	gone, err := collectStoredFiles(rows)
	if err != nil {
		return err
	}
	deleteStoredFiles(files, gone)

	type policy struct {
		org  uuid.UUID
		days int
	}
	rows, err = db.Query(ctx, `SELECT id, retention_days FROM organizations WHERE retention_days IS NOT NULL`)
	if err != nil {
		return err
	}
	policies, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (policy, error) {
		var p policy
		return p, row.Scan(&p.org, &p.days)
	})
	if err != nil {
		return err
	}
	for _, p := range policies {
		for {
			gone, n, err := expireBatch(ctx, db, p.org, now, p.days)
			if err != nil {
				return err
			}
			deleteStoredFiles(files, gone)
			if n < retentionBatch {
				break
			}
		}
	}
	return nil
}

// retentionBatch caps how many expired messages one transaction removes, so turning
// retention on for a long history does not lock the whole backlog at once.
const retentionBatch = 1000

// expireBatch removes up to retentionBatch of the workspace's expired messages and
// reports how many it took. Every message it takes leaves the expired set (deleted, or
// a placeholder that waits for its newer replies), so repeated calls finish.
func expireBatch(ctx context.Context, db *pgxpool.Pool, orgID uuid.UUID, now time.Time, days int) ([]storedFile, int, error) {
	var gone []storedFile
	var n int
	err := database.InTx(ctx, db, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT m.id FROM messages m
			WHERE m.org_id = $1 AND m.created_at < $2::timestamptz - make_interval(days => $3)
			  AND (m.body <> '' OR NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = m.id))
			LIMIT $4
			FOR UPDATE`, orgID, now, days, retentionBatch)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if n = len(ids); err != nil || n == 0 {
			return err
		}
		rows, err = tx.Query(ctx, `DELETE FROM attachments WHERE message_id = ANY ($1) RETURNING org_id, id`, ids)
		if err != nil {
			return err
		}
		if gone, err = collectStoredFiles(rows); err != nil {
			return err
		}
		// Replies first, then roots without replies; roots that keep newer replies become
		// placeholders.
		if _, err := tx.Exec(ctx, `DELETE FROM messages WHERE id = ANY ($1) AND parent_id IS NOT NULL`, ids); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM messages p WHERE p.id = ANY ($1)
			  AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = p.id)`, ids); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE messages SET body = '', deleted_at = coalesce(deleted_at, now()), edited_at = NULL, pinned_at = NULL, pinned_by = NULL
			WHERE id = ANY ($1) AND body <> ''`, ids); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM message_reactions WHERE message_id = ANY ($1)`, ids); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM message_mentions WHERE message_id = ANY ($1)`, ids)
		return err
	})
	return gone, n, err
}

type storedFile struct{ org, id uuid.UUID }

func collectStoredFiles(rows pgx.Rows) ([]storedFile, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (storedFile, error) {
		var f storedFile
		return f, row.Scan(&f.org, &f.id)
	})
}

// deleteStoredFiles removes files whose rows are already gone; a failure leaves an
// orphan on disk, which is logged.
func deleteStoredFiles(files storage.Store, gone []storedFile) {
	for _, f := range gone {
		if err := files.Delete(f.org, f.id); err != nil {
			slog.Warn("chat: delete expired file", "file", f.id, "error", err)
		}
	}
}
