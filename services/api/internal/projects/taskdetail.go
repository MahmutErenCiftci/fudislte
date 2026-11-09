package projects

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/chat"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

// A task's details: checklist, comments, links to channels and rooms, and activity.
// Comments follow the message rules (plain text, at most 4000 characters, rendered as
// text by clients). A link names its channel or room only to people who may see it.

const (
	maxChecklistItems = 50
	maxTaskLinks      = 20
	maxComments       = 500
	maxEvents         = 200
)

var (
	errTooManyItems  = httpx.NewError(http.StatusConflict, "too_many_items", "A checklist can have at most 50 items.")
	errTooManyLinks  = httpx.NewError(http.StatusConflict, "too_many_links", "A task can be linked to at most 20 conversations.")
	errNotCommenter  = httpx.NewError(http.StatusForbidden, "forbidden", "You can only edit your own comments.")
	errLinkTarget    = httpx.Invalid(map[string]string{"channelId": "Choose a channel you joined or a room you are in."})
	errCommentsSpeed = httpx.NewError(http.StatusTooManyRequests, "rate_limited", "You are sending messages too quickly. Wait a moment.")
)

// TaskDetail is a task with everything its dialog shows.
type TaskDetail struct {
	Task
	Description string          `json:"description"`
	Creator     *Person         `json:"creator"`
	Items       []ChecklistItem `json:"checklistItems"`
	Comments    []Comment       `json:"comments"`
	Links       []Link          `json:"links"`
	// Activity is newest first.
	Activity []Event `json:"activity"`
}

type ChecklistItem struct {
	ID       uuid.UUID `json:"id"`
	Text     string    `json:"text"`
	Done     bool      `json:"done"`
	Position int       `json:"position"`
}

type Comment struct {
	ID        uuid.UUID  `json:"id"`
	Author    *Person    `json:"author"`
	Body      string     `json:"body"`
	CreatedAt time.Time  `json:"createdAt"`
	EditedAt  *time.Time `json:"editedAt"`
}

// Link is a channel or a room the task is linked to.
type Link struct {
	chat.ChannelRef
	CreatedAt time.Time `json:"createdAt"`
}

// Event is one activity entry. Data depends on the kind; see docs/architecture/phase-5.md.
type Event struct {
	ID        uuid.UUID       `json:"id"`
	Kind      string          `json:"kind"`
	Actor     *Person         `json:"actor"`
	Data      json.RawMessage `json:"data"`
	CreatedAt time.Time       `json:"createdAt"`
	// Task names the task in project-wide activity.
	Task *TaskRef `json:"task,omitempty"`
}

type TaskRef struct {
	ID    uuid.UUID `json:"id"`
	Key   string    `json:"key"`
	Title string    `json:"title"`
}

func (s *Service) respondTask(w http.ResponseWriter, r *http.Request, m *org.Membership, p *Project, taskID uuid.UUID, status int) error {
	d, err := s.loadDetail(r.Context(), m, p, taskID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, status, map[string]any{"task": d})
	return nil
}

func (s *Service) loadDetail(ctx context.Context, m *org.Membership, p *Project, taskID uuid.UUID) (*TaskDetail, error) {
	t, err := loadTask(ctx, s.db, p.ID, taskID)
	if err != nil {
		return nil, err
	}
	d := TaskDetail{Task: *t}
	var creatorName *string
	if err := s.db.QueryRow(ctx, `SELECT t.description, u.display_name FROM tasks t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = $1`, taskID).
		Scan(&d.Description, &creatorName); err != nil {
		return nil, err
	}
	if t.CreatedBy != nil && creatorName != nil {
		d.Creator = &Person{ID: *t.CreatedBy, DisplayName: *creatorName}
	}
	rows, err := s.db.Query(ctx, `SELECT id, text, done, position FROM task_checklist_items WHERE task_id = $1 ORDER BY position, id`, taskID)
	if err != nil {
		return nil, err
	}
	if d.Items, err = pgx.CollectRows(rows, pgx.RowToStructByPos[ChecklistItem]); err != nil {
		return nil, err
	}
	if d.Comments, err = loadComments(ctx, s.db, ` WHERE c.task_id = $1 ORDER BY c.id DESC LIMIT $2`, taskID, maxComments); err != nil {
		return nil, err
	}
	slices.Reverse(d.Comments)
	if d.Links, err = loadLinks(ctx, s.db, m, taskID); err != nil {
		return nil, err
	}
	if d.Activity, err = s.loadEvents(ctx, m, ` WHERE e.task_id = $1 ORDER BY e.id DESC LIMIT $2`, taskID, maxEvents); err != nil {
		return nil, err
	}
	return &d, nil
}

func loadComments(ctx context.Context, q database.Querier, filter string, args ...any) ([]Comment, error) {
	rows, err := q.Query(ctx, `
		SELECT c.id, c.body, c.created_at, c.edited_at, u.id, u.display_name
		FROM task_comments c LEFT JOIN users u ON u.id = c.author_id`+filter, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Comment, error) {
		var (
			c          Comment
			authorID   *uuid.UUID
			authorName *string
		)
		err := row.Scan(&c.ID, &c.Body, &c.CreatedAt, &c.EditedAt, &authorID, &authorName)
		if authorID != nil && authorName != nil {
			c.Author = &Person{ID: *authorID, DisplayName: *authorName}
		}
		return c, err
	})
}

// loadLinks returns the task's links the caller may see.
func loadLinks(ctx context.Context, q database.Querier, m *org.Membership, taskID uuid.UUID) ([]Link, error) {
	rows, err := q.Query(ctx, `SELECT channel_id, created_at FROM task_links WHERE task_id = $1 ORDER BY created_at, channel_id`, taskID)
	if err != nil {
		return nil, err
	}
	type stored struct {
		id uuid.UUID
		at time.Time
	}
	all, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (stored, error) {
		var l stored
		err := row.Scan(&l.id, &l.at)
		return l, err
	})
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(all))
	for i, l := range all {
		ids[i] = l.id
	}
	visible, err := chat.VisibleChannels(ctx, q, m, ids)
	if err != nil {
		return nil, err
	}
	links := []Link{}
	for _, l := range all {
		if ref, ok := visible[l.id]; ok {
			links = append(links, Link{ChannelRef: ref, CreatedAt: l.at})
		}
	}
	return links, nil
}

// loadEvents reads activity entries. Link entries name their channel or room only when
// the caller may see it.
func (s *Service) loadEvents(ctx context.Context, m *org.Membership, filter string, args ...any) ([]Event, error) {
	rows, err := s.db.Query(ctx, `
		SELECT e.id, e.kind, e.data, e.created_at, u.id, u.display_name, t.id, p.key || '-' || t.number, t.title
		FROM task_events e
		JOIN tasks t ON t.id = e.task_id
		JOIN projects p ON p.id = t.project_id
		LEFT JOIN users u ON u.id = e.actor_id`+filter, args...)
	if err != nil {
		return nil, err
	}
	events, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Event, error) {
		var (
			e         Event
			actorID   *uuid.UUID
			actorName *string
			task      TaskRef
		)
		err := row.Scan(&e.ID, &e.Kind, &e.Data, &e.CreatedAt, &actorID, &actorName, &task.ID, &task.Key, &task.Title)
		if actorID != nil && actorName != nil {
			e.Actor = &Person{ID: *actorID, DisplayName: *actorName}
		}
		e.Task = &task
		return e, err
	})
	if err != nil {
		return nil, err
	}
	var linked []uuid.UUID
	for _, e := range events {
		if e.Kind == "linked" || e.Kind == "unlinked" {
			var data struct {
				ChannelID uuid.UUID `json:"channelId"`
			}
			if json.Unmarshal(e.Data, &data) == nil {
				linked = append(linked, data.ChannelID)
			}
		}
	}
	visible, err := chat.VisibleChannels(ctx, s.db, m, linked)
	if err != nil {
		return nil, err
	}
	for i, e := range events {
		if e.Kind != "linked" && e.Kind != "unlinked" {
			continue
		}
		var data struct {
			ChannelID uuid.UUID `json:"channelId"`
		}
		_ = json.Unmarshal(e.Data, &data)
		out := map[string]any{}
		if ref, ok := visible[data.ChannelID]; ok {
			out["channel"] = ref
		}
		events[i].Data, _ = json.Marshal(out)
	}
	return events, nil
}

// detailTarget loads the project and task of a checklist, comment or link request for
// someone who may change the task.
func (s *Service) detailTarget(r *http.Request) (*org.Membership, *Project, uuid.UUID, error) {
	m, p, err := s.editableProject(r)
	if err != nil {
		return nil, nil, uuid.Nil, err
	}
	taskID, err := taskIDFromRequest(r)
	if err != nil {
		return nil, nil, uuid.Nil, err
	}
	var exists bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2)`, taskID, p.ID).Scan(&exists); err != nil {
		return nil, nil, uuid.Nil, err
	}
	if !exists {
		return nil, nil, uuid.Nil, httpx.ErrNotFound
	}
	return m, p, taskID, nil
}

// touch marks the task changed and tells the project's viewers.
func (s *Service) touch(w http.ResponseWriter, r *http.Request, m *org.Membership, p *Project, taskID uuid.UUID, status int) error {
	if _, err := s.db.Exec(r.Context(), `UPDATE tasks SET updated_at = now() WHERE id = $1`, taskID); err != nil {
		return err
	}
	return s.taskChanged(w, r, m, p, taskID, status)
}

func (s *Service) AddChecklistItem(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, taskID, err := s.detailTarget(r)
	if err != nil {
		return err
	}
	var in struct {
		Text string `json:"text"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	text, msg := NormalizeLine(in.Text, 200)
	if msg != "" {
		return httpx.Invalid(map[string]string{"text": msg})
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := lockTask(ctx, tx, p.ID, taskID); err != nil {
			return err
		}
		var count, next int
		if err := tx.QueryRow(ctx, `SELECT count(*), coalesce(max(position) + 1, 0) FROM task_checklist_items WHERE task_id = $1`, taskID).Scan(&count, &next); err != nil {
			return err
		}
		if count >= maxChecklistItems {
			return errTooManyItems
		}
		_, err := tx.Exec(ctx, `INSERT INTO task_checklist_items (id, task_id, text, position) VALUES ($1, $2, $3, $4)`,
			uuid.Must(uuid.NewV7()), taskID, text, next)
		return err
	})
	if err != nil {
		return err
	}
	return s.touch(w, r, m, p, taskID, http.StatusCreated)
}

func (s *Service) UpdateChecklistItem(w http.ResponseWriter, r *http.Request) error {
	m, p, taskID, err := s.detailTarget(r)
	if err != nil {
		return err
	}
	itemID, err := uuid.Parse(chi.URLParam(r, "itemID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	var in struct {
		Text *string `json:"text"`
		Done *bool   `json:"done"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	var text *string
	if in.Text != nil {
		v, msg := NormalizeLine(*in.Text, 200)
		if msg != "" {
			return httpx.Invalid(map[string]string{"text": msg})
		}
		text = &v
	}
	tag, err := s.db.Exec(r.Context(), `
		UPDATE task_checklist_items SET text = coalesce($3, text), done = coalesce($4, done) WHERE id = $1 AND task_id = $2`,
		itemID, taskID, text, in.Done)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.ErrNotFound
	}
	return s.touch(w, r, m, p, taskID, http.StatusOK)
}

func (s *Service) DeleteChecklistItem(w http.ResponseWriter, r *http.Request) error {
	m, p, taskID, err := s.detailTarget(r)
	if err != nil {
		return err
	}
	itemID, err := uuid.Parse(chi.URLParam(r, "itemID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM task_checklist_items WHERE id = $1 AND task_id = $2`, itemID, taskID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.ErrNotFound
	}
	return s.touch(w, r, m, p, taskID, http.StatusOK)
}

// normalizeComment applies the message text rules.
func normalizeComment(s string) (string, string) {
	body, msg := NormalizeText(s, 10000)
	switch {
	case msg != "":
		return "", "Messages can be at most 4000 characters."
	case body == "":
		return "", "Write a message."
	case len([]rune(body)) > 4000:
		return "", "Messages can be at most 4000 characters."
	}
	return body, ""
}

func (s *Service) AddComment(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, taskID, err := s.detailTarget(r)
	if err != nil {
		return err
	}
	if !s.commentsByUser.Allow(m.UserID.String()) {
		return errCommentsSpeed
	}
	var in struct {
		Body string `json:"body"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	body, msg := normalizeComment(in.Body)
	if msg != "" {
		return httpx.Invalid(map[string]string{"body": msg})
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO task_comments (id, task_id, author_id, body) VALUES ($1, $2, $3, $4)`,
		uuid.Must(uuid.NewV7()), taskID, m.UserID, body); err != nil {
		return err
	}
	return s.touch(w, r, m, p, taskID, http.StatusCreated)
}

// commentFromRequest loads the {commentID} comment of the task.
func (s *Service) commentFromRequest(r *http.Request, taskID uuid.UUID) (*Comment, error) {
	id, err := uuid.Parse(chi.URLParam(r, "commentID"))
	if err != nil {
		return nil, httpx.ErrNotFound
	}
	comments, err := loadComments(r.Context(), s.db, ` WHERE c.id = $1 AND c.task_id = $2`, id, taskID)
	if err != nil {
		return nil, err
	}
	if len(comments) == 0 {
		return nil, httpx.ErrNotFound
	}
	return &comments[0], nil
}

// EditComment changes the caller's own comment.
func (s *Service) EditComment(w http.ResponseWriter, r *http.Request) error {
	m, p, taskID, err := s.detailTarget(r)
	if err != nil {
		return err
	}
	c, err := s.commentFromRequest(r, taskID)
	if err != nil {
		return err
	}
	if c.Author == nil || c.Author.ID != m.UserID {
		return errNotCommenter
	}
	var in struct {
		Body string `json:"body"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	body, msg := normalizeComment(in.Body)
	if msg != "" {
		return httpx.Invalid(map[string]string{"body": msg})
	}
	if body != c.Body {
		if _, err := s.db.Exec(r.Context(), `UPDATE task_comments SET body = $2, edited_at = now() WHERE id = $1`, c.ID, body); err != nil {
			return err
		}
	}
	return s.touch(w, r, m, p, taskID, http.StatusOK)
}

// DeleteComment removes a comment: its author, or a lead or project manager.
func (s *Service) DeleteComment(w http.ResponseWriter, r *http.Request) error {
	m, p, taskID, err := s.detailTarget(r)
	if err != nil {
		return err
	}
	c, err := s.commentFromRequest(r, taskID)
	if err != nil {
		return err
	}
	if !p.CanManage && (c.Author == nil || c.Author.ID != m.UserID) {
		return httpx.ErrForbidden
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM task_comments WHERE id = $1`, c.ID); err != nil {
		return err
	}
	return s.touch(w, r, m, p, taskID, http.StatusOK)
}

// AddLink links the task to a channel the caller joined or a room they are admitted to.
func (s *Service) AddLink(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, taskID, err := s.detailTarget(r)
	if err != nil {
		return err
	}
	var in struct {
		ChannelID uuid.UUID `json:"channelId"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	visible, err := chat.VisibleChannels(ctx, s.db, m, []uuid.UUID{in.ChannelID})
	if err != nil {
		return err
	}
	if ref, ok := visible[in.ChannelID]; !ok || !ref.Joined {
		return errLinkTarget
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := lockTask(ctx, tx, p.ID, taskID); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM task_links WHERE task_id = $1`, taskID).Scan(&count); err != nil {
			return err
		}
		if count >= maxTaskLinks {
			return errTooManyLinks
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO task_links (task_id, org_id, channel_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
			taskID, m.Org.ID, in.ChannelID, m.UserID)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		return recordEvent(ctx, tx, p.ID, taskID, m.UserID, "linked", map[string]any{"channelId": in.ChannelID})
	})
	if err != nil {
		return err
	}
	s.channelTasksChanged(ctx, m.Org.ID, in.ChannelID)
	return s.touch(w, r, m, p, taskID, http.StatusOK)
}

// RemoveLink unlinks the task from a channel or room.
func (s *Service) RemoveLink(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, taskID, err := s.detailTarget(r)
	if err != nil {
		return err
	}
	channelID, err := uuid.Parse(chi.URLParam(r, "channelID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM task_links WHERE task_id = $1 AND channel_id = $2`, taskID, channelID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.ErrNotFound
		}
		return recordEvent(ctx, tx, p.ID, taskID, m.UserID, "unlinked", map[string]any{"channelId": channelID})
	})
	if err != nil {
		return err
	}
	s.channelTasksChanged(ctx, m.Org.ID, channelID)
	return s.touch(w, r, m, p, taskID, http.StatusOK)
}

// channelTasksChanged tells the people in a channel or room that its linked tasks
// changed; the event carries no task data, they refetch what they may see.
func (s *Service) channelTasksChanged(ctx context.Context, orgID, channelID uuid.UUID) {
	ids, err := chat.ChannelMembers(ctx, s.db, channelID)
	if err != nil {
		return
	}
	s.events.Publish(ids, realtime.Event{Type: "channel.tasks", Data: map[string]any{"orgId": orgID, "channelId": channelID}})
}

// ChannelTasks lists the tasks linked to a channel or a room that the caller may see.
// Room links are room content: only people admitted see them.
func (s *Service) ChannelTasks(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	channelID, err := uuid.Parse(chi.URLParam(r, "channelID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	visible, err := chat.VisibleChannels(ctx, s.db, m, []uuid.UUID{channelID})
	if err != nil {
		return err
	}
	ref, ok := visible[channelID]
	if !ok || (ref.Kind == chat.KindRoom && !ref.Joined) {
		return httpx.ErrNotFound
	}
	tasks, err := queryVisibleTasks(ctx, s.db, m, `
		AND EXISTS (SELECT 1 FROM task_links l WHERE l.task_id = t.id AND l.channel_id = $4)
		ORDER BY s.category = 'done', t.updated_at DESC LIMIT 100`, channelID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
	return nil
}
