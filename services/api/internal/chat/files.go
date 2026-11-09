package chat

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
	"fudislte/api/internal/org"
	"fudislte/api/internal/storage"
)

// Attachments (ADR-0009): uploaded to a channel, then sent with a message.

type Attachment struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	ContentType string    `json:"contentType"`
	Size        int64     `json:"size"`
	// Image marks PNG, JPEG, GIF and WebP files, which may be shown inline.
	Image     bool       `json:"image"`
	CreatedAt time.Time  `json:"createdAt"`
	Uploader  *Author    `json:"uploader,omitempty"`
	MessageID *uuid.UUID `json:"messageId,omitempty"`
}

const (
	maxAttachmentsPerMessage = 10
	unsentAttachmentTTL      = 24 * time.Hour
	// Large files on slow connections need longer than the server's read and write
	// timeouts, which suit ordinary API calls.
	uploadTimeout   = 10 * time.Minute
	downloadTimeout = 30 * time.Minute
)

var (
	errNoFile         = httpx.Invalid(map[string]string{"file": "Choose a file."})
	errEmptyFile      = httpx.Invalid(map[string]string{"file": "The file is empty."})
	errBadAttachments = httpx.Invalid(map[string]string{"attachmentIds": "Attach files you uploaded to this channel."})
)

// inlineTypes are shown in the browser; every other file is only ever downloaded.
var inlineTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

func isInlineImage(contentType string) bool { return inlineTypes[contentType] }

// cleanFileName keeps the base name, without control characters, at most 255
// characters; "file" when nothing usable remains.
func cleanFileName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '/' {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	for utf8.RuneCountInString(name) > 255 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}

// detectType names the content from its first bytes; the client's claim is ignored.
func detectType(head []byte) string {
	t := http.DetectContentType(head)
	if mt, _, err := mime.ParseMediaType(t); err == nil {
		return mt
	}
	return "application/octet-stream"
}

// UploadFile stores one file ("file" in a multipart form) for the caller to send in
// the channel.
func (s *Service) UploadFile(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if err := c.writableBy(); err != nil {
		return err
	}
	if !s.uploadsByUser.Allow(m.UserID.String()) {
		return errTooFast
	}
	// The response is written after the whole body is read, so both deadlines move.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(uploadTimeout))
	_ = rc.SetWriteDeadline(time.Now().Add(uploadTimeout + time.Minute))
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUpload+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return errNoFile
	}
	var part io.Reader
	var name string
	for {
		p, err := mr.NextPart()
		if err != nil {
			return errNoFile
		}
		if p.FormName() == "file" && p.FileName() != "" {
			part, name = p, cleanFileName(p.FileName())
			break
		}
	}

	id := uuid.Must(uuid.NewV7())
	stored, err := s.files.Put(m.Org.ID, id, part, s.maxUpload)
	var maxErr *http.MaxBytesError
	if errors.Is(err, storage.ErrTooLarge) || errors.As(err, &maxErr) {
		return httpx.NewError(http.StatusRequestEntityTooLarge, "file_too_large",
			i18n.Tf(i18n.FromContext(ctx), "Files can be at most %d MB.", s.maxUpload>>20))
	}
	if err != nil {
		return err
	}
	if stored.Size == 0 {
		_ = s.files.Delete(m.Org.ID, id)
		return errEmptyFile
	}
	a := Attachment{ID: id, Name: name, ContentType: detectType(stored.Head), Size: stored.Size}
	a.Image = isInlineImage(a.ContentType)
	if err := s.db.QueryRow(ctx, `
		INSERT INTO attachments (id, org_id, channel_id, uploader_id, name, content_type, size, sha256)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING created_at`,
		id, m.Org.ID, c.ID, m.UserID, a.Name, a.ContentType, a.Size, stored.SHA256).Scan(&a.CreatedAt); err != nil {
		_ = s.files.Delete(m.Org.ID, id)
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"attachment": a})
	return nil
}

// attachToMessage gives unsent uploads of the author in the channel to a message.
func attachToMessage(ctx context.Context, tx pgx.Tx, channelID, authorID, messageID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	ids = unique(ids)
	if len(ids) > maxAttachmentsPerMessage {
		return httpx.Invalid(map[string]string{"attachmentIds": "Attach at most 10 files to a message."})
	}
	tag, err := tx.Exec(ctx, `
		UPDATE attachments SET message_id = $4
		WHERE id = ANY ($1) AND channel_id = $2 AND uploader_id = $3 AND message_id IS NULL`, ids, channelID, authorID, messageID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != int64(len(ids)) {
		return errBadAttachments
	}
	return nil
}

type attachmentRow struct {
	ID        uuid.UUID
	ChannelID uuid.UUID
	Uploader  *uuid.UUID
	MessageID *uuid.UUID
	Name      string
	Type      string
	CreatedAt time.Time
}

// DownloadFile sends a file to someone who may see its channel. Unsent files are only
// for their uploader.
func (s *Service) DownloadFile(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "fileID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	var a attachmentRow
	err = s.db.QueryRow(ctx, `
		SELECT id, channel_id, uploader_id, message_id, name, content_type, created_at
		FROM attachments WHERE id = $1 AND org_id = $2`, id, m.Org.ID).
		Scan(&a.ID, &a.ChannelID, &a.Uploader, &a.MessageID, &a.Name, &a.Type, &a.CreatedAt)
	if isNoRows(err) {
		return httpx.ErrNotFound
	}
	if err != nil {
		return err
	}
	if a.MessageID == nil && (a.Uploader == nil || *a.Uploader != m.UserID) {
		return httpx.ErrNotFound
	}
	if _, err := loadChannel(ctx, s.db, m, a.ChannelID); err != nil {
		return err
	}
	f, err := s.files.Open(m.Org.ID, a.ID)
	if errors.Is(err, os.ErrNotExist) {
		return httpx.ErrNotFound
	}
	if err != nil {
		return err
	}
	defer f.Close()

	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'")
	h.Set("Cache-Control", "private, max-age=3600")
	disposition := "attachment"
	if isInlineImage(a.Type) && r.URL.Query().Get("download") == "" {
		disposition = "inline"
		h.Set("Content-Type", a.Type)
	} else {
		h.Set("Content-Type", "application/octet-stream")
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": a.Name}))
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(downloadTimeout))
	http.ServeContent(w, r, "", a.CreatedAt, f)
	return nil
}

// DeleteUpload removes an upload the caller has not sent yet.
func (s *Service) DeleteUpload(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "fileID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM attachments WHERE id = $1 AND org_id = $2 AND uploader_id = $3 AND message_id IS NULL`,
		id, m.Org.ID, m.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.ErrNotFound
	}
	s.removeFiles(m.Org.ID, []uuid.UUID{id})
	httpx.NoContent(w)
	return nil
}

// ListFiles returns the files sent in a channel, newest first: its "Dosyalar" tab.
func (s *Service) ListFiles(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	_, c, err := channelFromRequest(r, s.db)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `
		SELECT a.id, a.name, a.content_type, a.size, a.created_at, a.message_id, u.id, u.display_name
		FROM attachments a
		LEFT JOIN users u ON u.id = a.uploader_id
		WHERE a.channel_id = $1 AND a.message_id IS NOT NULL
		ORDER BY a.created_at DESC, a.id
		LIMIT 200`, c.ID)
	if err != nil {
		return err
	}
	files, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Attachment, error) {
		var (
			a        Attachment
			userID   *uuid.UUID
			userName *string
		)
		err := row.Scan(&a.ID, &a.Name, &a.ContentType, &a.Size, &a.CreatedAt, &a.MessageID, &userID, &userName)
		if userID != nil {
			a.Uploader = &Author{ID: *userID, DisplayName: *userName}
		}
		a.Image = isInlineImage(a.ContentType)
		return a, err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"files": files})
	return nil
}

func enrichAttachments(ctx context.Context, q database.Querier, msgs []*Message) error {
	if len(msgs) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `
		SELECT message_id, id, name, content_type, size, created_at FROM attachments
		WHERE message_id = ANY ($1) ORDER BY created_at, id`, ids(msgs))
	if err != nil {
		return err
	}
	index := byID(msgs)
	var (
		messageID uuid.UUID
		a         Attachment
	)
	_, err = pgx.ForEachRow(rows, []any{&messageID, &a.ID, &a.Name, &a.ContentType, &a.Size, &a.CreatedAt}, func() error {
		a.Image = isInlineImage(a.ContentType)
		index[messageID].Attachments = append(index[messageID].Attachments, a)
		return nil
	})
	return err
}

// detachFiles deletes the attachment rows of messages inside tx and returns their IDs;
// pass them to removeFiles once the transaction has committed.
func detachFiles(ctx context.Context, tx pgx.Tx, messageIDs ...uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `DELETE FROM attachments WHERE message_id = ANY ($1) RETURNING id`, messageIDs)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

func (s *Service) removeFiles(orgID uuid.UUID, ids []uuid.UUID) {
	for _, id := range ids {
		if err := s.files.Delete(orgID, id); err != nil {
			slog.Warn("chat: delete file", "file", id, "error", err)
		}
	}
}
