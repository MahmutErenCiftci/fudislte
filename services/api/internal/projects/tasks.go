package projects

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

// Tasks. Members of an active project create, edit and move them; everyone who may see
// the project reads them and receives task.updated events. Each change leaves an
// activity entry (task_events) in the same transaction.

const (
	maxAssignees  = 10
	maxTaskLabels = 10
	// maxProjectTasks bounds one board's list.
	maxProjectTasks = 5000
)

var priorities = []string{"none", "low", "medium", "high", "urgent"}

var errTooFast = httpx.NewError(http.StatusTooManyRequests, "rate_limited", "You are making changes too quickly. Wait a moment.")

// Task is a task as boards, lists and other modules show it.
type Task struct {
	ID           uuid.UUID  `json:"id"`
	Project      ProjectRef `json:"project"`
	Number       int        `json:"number"`
	Key          string     `json:"key"`
	Title        string     `json:"title"`
	Status       TaskStatus `json:"status"`
	Priority     string     `json:"priority"`
	DueOn        *string    `json:"dueOn"`
	SprintID     *uuid.UUID `json:"sprintId"`
	Rank         string     `json:"rank"`
	Assignees    []Person   `json:"assignees"`
	Labels       []Label    `json:"labels"`
	Checklist    Progress   `json:"checklist"`
	CommentCount int        `json:"commentCount"`
	CreatedBy    *uuid.UUID `json:"createdBy"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	CompletedAt  *time.Time `json:"completedAt"`
}

type TaskStatus struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Category string    `json:"category"`
	Color    string    `json:"color"`
}

type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

const taskSelect = `
	SELECT t.id, p.id, p.key, p.name, p.color, t.number, t.title, s.id, s.name, s.category, s.color,
	       t.priority, to_char(t.due_on, 'YYYY-MM-DD'), t.sprint_id, t.rank, t.created_by, t.created_at, t.updated_at, t.completed_at,
	       (SELECT count(*) FROM task_checklist_items c WHERE c.task_id = t.id),
	       (SELECT count(*) FROM task_checklist_items c WHERE c.task_id = t.id AND c.done),
	       (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id)
	FROM tasks t
	JOIN projects p ON p.id = t.project_id
	JOIN task_statuses s ON s.id = t.status_id`

// visibleTasks restricts taskSelect to workspace $1 and projects the caller ($2) may
// see; $3 is whether they may view public projects.
const visibleTasks = taskSelect + `
	LEFT JOIN project_members vm ON vm.project_id = p.id AND vm.user_id = $2
	WHERE t.org_id = $1 AND (vm.user_id IS NOT NULL OR (p.visibility = 'public' AND $3))`

func queryTasks(ctx context.Context, q database.Querier, query string, args ...any) ([]Task, error) {
	rows, err := q.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	tasks, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Task, error) {
		var t Task
		err := row.Scan(&t.ID, &t.Project.ID, &t.Project.Key, &t.Project.Name, &t.Project.Color, &t.Number, &t.Title,
			&t.Status.ID, &t.Status.Name, &t.Status.Category, &t.Status.Color, &t.Priority, &t.DueOn, &t.SprintID, &t.Rank,
			&t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, &t.CompletedAt, &t.Checklist.Total, &t.Checklist.Done, &t.CommentCount)
		t.Key = t.Project.Key + "-" + strconv.Itoa(t.Number)
		return t, err
	})
	if err != nil {
		return nil, err
	}
	return tasks, fillTaskPeople(ctx, q, tasks)
}

func queryVisibleTasks(ctx context.Context, q database.Querier, m *org.Membership, filter string, args ...any) ([]Task, error) {
	return queryTasks(ctx, q, visibleTasks+filter, append([]any{m.Org.ID, m.UserID, m.Can(org.PermProjectsView)}, args...)...)
}

// fillTaskPeople adds assignees and labels to tasks.
func fillTaskPeople(ctx context.Context, q database.Querier, tasks []Task) error {
	if len(tasks) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(tasks))
	index := make(map[uuid.UUID]int, len(tasks))
	for i := range tasks {
		ids[i] = tasks[i].ID
		index[tasks[i].ID] = i
		tasks[i].Assignees, tasks[i].Labels = []Person{}, []Label{}
	}
	rows, err := q.Query(ctx, `
		SELECT a.task_id, u.id, u.display_name FROM task_assignees a JOIN users u ON u.id = a.user_id
		WHERE a.task_id = ANY ($1) ORDER BY a.assigned_at, u.id`, ids)
	if err != nil {
		return err
	}
	var (
		taskID uuid.UUID
		person Person
		label  Label
	)
	if _, err := pgx.ForEachRow(rows, []any{&taskID, &person.ID, &person.DisplayName}, func() error {
		tasks[index[taskID]].Assignees = append(tasks[index[taskID]].Assignees, person)
		return nil
	}); err != nil {
		return err
	}
	rows, err = q.Query(ctx, `
		SELECT tl.task_id, l.id, l.name, l.color FROM task_labels tl JOIN project_labels l ON l.id = tl.label_id
		WHERE tl.task_id = ANY ($1) ORDER BY lower(l.name), l.id`, ids)
	if err != nil {
		return err
	}
	_, err = pgx.ForEachRow(rows, []any{&taskID, &label.ID, &label.Name, &label.Color}, func() error {
		tasks[index[taskID]].Labels = append(tasks[index[taskID]].Labels, label)
		return nil
	})
	return err
}

func loadTask(ctx context.Context, q database.Querier, projectID, taskID uuid.UUID) (*Task, error) {
	tasks, err := queryTasks(ctx, q, taskSelect+` WHERE t.id = $1 AND t.project_id = $2`, taskID, projectID)
	if err != nil {
		return nil, err
	}
	if len(tasks) == 0 {
		return nil, httpx.ErrNotFound
	}
	return &tasks[0], nil
}

func taskIDFromRequest(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, "taskID"))
	if err != nil {
		return uuid.Nil, httpx.ErrNotFound
	}
	return id, nil
}

// publishTask sends the task's new state to everyone who may see its project.
func (s *Service) publishTask(ctx context.Context, orgID uuid.UUID, t *Task) {
	s.publishProject(ctx, orgID, t.Project.ID, realtime.Event{Type: "task.updated", Data: map[string]any{
		"orgId": orgID, "projectId": t.Project.ID, "task": t,
	}})
}

// ListTasks returns every task of the project, each column in rank order.
func (s *Service) ListTasks(w http.ResponseWriter, r *http.Request) error {
	_, p, err := projectFromRequest(r, s.db)
	if err != nil {
		return err
	}
	tasks, err := queryTasks(r.Context(), s.db, taskSelect+` WHERE t.project_id = $1 ORDER BY t.rank, t.id LIMIT $2`, p.ID, maxProjectTasks)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
	return nil
}

func (s *Service) GetTask(w http.ResponseWriter, r *http.Request) error {
	m, p, err := projectFromRequest(r, s.db)
	if err != nil {
		return err
	}
	taskID, err := taskIDFromRequest(r)
	if err != nil {
		return err
	}
	return s.respondTask(w, r, m, p, taskID, http.StatusOK)
}

// taskInput is the body of POST and PATCH; absent fields keep their value and null
// clears the due date or the sprint.
type taskInput struct {
	Title       *string             `json:"title"`
	Description *string             `json:"description"`
	StatusID    *uuid.UUID          `json:"statusId"`
	Rank        *string             `json:"rank"`
	Priority    *string             `json:"priority"`
	DueOn       optional[string]    `json:"dueOn"`
	SprintID    optional[uuid.UUID] `json:"sprintId"`
	AssigneeIDs *[]uuid.UUID        `json:"assigneeIds"`
	LabelIDs    *[]uuid.UUID        `json:"labelIds"`
}

// taskValues are a task's editable fields.
type taskValues struct {
	title, description, priority string
	statusID                     uuid.UUID
	rank                         string
	dueOn                        *string
	sprintID                     *uuid.UUID
	assignees, labels            []uuid.UUID
}

// validate applies the input's own rules; references to statuses, sprints, members and
// labels are checked against the database by the caller.
func (in *taskInput) validate(v *taskValues) error {
	fields := map[string]string{}
	var msg string
	if in.Title != nil {
		if v.title, msg = NormalizeLine(*in.Title, 200); msg != "" {
			fields["title"] = msg
		}
	}
	if in.Description != nil {
		if v.description, msg = NormalizeText(*in.Description, 10000); msg != "" {
			fields["description"] = msg
		}
	}
	if in.Priority != nil {
		if v.priority = *in.Priority; !slices.Contains(priorities, v.priority) {
			fields["priority"] = "Choose a priority."
		}
	}
	if in.Rank != nil && !validRank(*in.Rank) {
		fields["rank"] = "The position is not valid."
	}
	if in.DueOn.Set {
		if v.dueOn, msg = normalizeDate(in.DueOn.Value); msg != "" {
			fields["dueOn"] = msg
		}
	}
	if in.SprintID.Set {
		v.sprintID = in.SprintID.Value
	}
	if in.AssigneeIDs != nil {
		if v.assignees = unique(*in.AssigneeIDs); len(v.assignees) > maxAssignees {
			fields["assigneeIds"] = "Assign at most 10 people."
		}
	}
	if in.LabelIDs != nil {
		if v.labels = unique(*in.LabelIDs); len(v.labels) > maxTaskLabels {
			fields["labelIds"] = "Choose at most 10 labels."
		}
	}
	if v.title == "" && fields["title"] == "" {
		fields["title"] = lineLimits[200]
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	return nil
}

// CreateTask adds a task at the end of its status column (the first column unless
// statusId says otherwise) with the project's next number.
func (s *Service) CreateTask(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.editableProject(r)
	if err != nil {
		return err
	}
	if !s.taskWrites.Allow(m.UserID.String()) {
		return errTooFast
	}
	var in taskInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Title == nil {
		in.Title = new(string)
	}
	v := taskValues{priority: "none", assignees: []uuid.UUID{}, labels: []uuid.UUID{}}
	if err := in.validate(&v); err != nil {
		return err
	}
	id := uuid.Must(uuid.NewV7())
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		// The row lock orders concurrent creations: numbers and ranks stay unique.
		var number int
		err := tx.QueryRow(ctx, `UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING task_seq`,
			p.ID, m.Org.ID).Scan(&number)
		if isNoRows(err) {
			return errArchived
		}
		if err != nil {
			return err
		}
		var status *Status
		if in.StatusID != nil {
			status, err = loadStatus(ctx, tx, p.ID, *in.StatusID)
			if err != nil {
				return httpx.Invalid(map[string]string{"statusId": "Choose a status of this project."})
			}
		} else {
			status = &Status{}
			if err := tx.QueryRow(ctx, `SELECT id, name, category, color, position FROM task_statuses WHERE project_id = $1 ORDER BY position, id LIMIT 1`, p.ID).
				Scan(&status.ID, &status.Name, &status.Category, &status.Color, &status.Position); err != nil {
				return err
			}
		}
		if err := checkReferences(ctx, tx, p.ID, &v); err != nil {
			return err
		}
		last, err := lastRank(ctx, tx, status.ID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO tasks (id, org_id, project_id, number, title, description, status_id, priority, due_on, sprint_id, rank, created_by, completed_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, CASE WHEN $13 THEN now() END)`,
			id, m.Org.ID, p.ID, number, v.title, v.description, status.ID, v.priority, v.dueOn, v.sprintID, rankAfter(last), m.UserID,
			status.Category == CategoryDone); err != nil {
			return err
		}
		if err := setAssignees(ctx, tx, p.ID, id, v.assignees); err != nil {
			return err
		}
		if err := setLabels(ctx, tx, p.ID, id, v.labels); err != nil {
			return err
		}
		if err := recordEvent(ctx, tx, p.ID, id, m.UserID, "created", nil); err != nil {
			return err
		}
		for _, person := range mustNames(ctx, tx, v.assignees) {
			if err := recordEvent(ctx, tx, p.ID, id, m.UserID, "assigned", map[string]any{"user": person}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	return s.taskChanged(w, r, m, p, id, http.StatusCreated)
}

// taskChanged tells the project's viewers and answers with the task's details.
func (s *Service) taskChanged(w http.ResponseWriter, r *http.Request, m *org.Membership, p *Project, taskID uuid.UUID, status int) error {
	t, err := loadTask(r.Context(), s.db, p.ID, taskID)
	if err != nil {
		return err
	}
	s.publishTask(r.Context(), m.Org.ID, t)
	return s.respondTask(w, r, m, p, taskID, status)
}

// checkReferences makes sure the sprint, assignees and labels belong to the project.
func checkReferences(ctx context.Context, q database.Querier, projectID uuid.UUID, v *taskValues) error {
	if v.sprintID != nil {
		var state string
		err := q.QueryRow(ctx, `SELECT state FROM sprints WHERE id = $1 AND project_id = $2`, *v.sprintID, projectID).Scan(&state)
		if isNoRows(err) || state == SprintCompleted {
			return httpx.Invalid(map[string]string{"sprintId": "Choose a planned or active sprint of this project."})
		}
		if err != nil {
			return err
		}
	}
	if err := projectMembers(ctx, q, projectID, v.assignees); err != nil {
		return err
	}
	if len(v.labels) > 0 {
		var known int
		if err := q.QueryRow(ctx, `SELECT count(*) FROM project_labels WHERE project_id = $1 AND id = ANY ($2)`, projectID, v.labels).Scan(&known); err != nil {
			return err
		}
		if known != len(v.labels) {
			return httpx.Invalid(map[string]string{"labelIds": "Choose labels of this project."})
		}
	}
	return nil
}

func setAssignees(ctx context.Context, tx pgx.Tx, projectID, taskID uuid.UUID, ids []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `DELETE FROM task_assignees WHERE task_id = $1 AND NOT (user_id = ANY ($2))`, taskID, ids); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO task_assignees (task_id, project_id, user_id)
		SELECT $1, $2, u FROM unnest($3::uuid[]) AS u ON CONFLICT DO NOTHING`, taskID, projectID, ids)
	return err
}

func setLabels(ctx context.Context, tx pgx.Tx, projectID, taskID uuid.UUID, ids []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `DELETE FROM task_labels WHERE task_id = $1 AND NOT (label_id = ANY ($2))`, taskID, ids); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO task_labels (task_id, project_id, label_id)
		SELECT $1, $2, l FROM unnest($3::uuid[]) AS l ON CONFLICT DO NOTHING`, taskID, projectID, ids)
	return err
}

// currentTask is a task's stored fields, read under a row lock.
type currentTask struct {
	taskValues
	number    int
	createdBy *uuid.UUID
}

func lockTask(ctx context.Context, tx pgx.Tx, projectID, taskID uuid.UUID) (*currentTask, error) {
	var c currentTask
	err := tx.QueryRow(ctx, `
		SELECT number, title, description, status_id, priority, to_char(due_on, 'YYYY-MM-DD'), sprint_id, rank, created_by,
		       ARRAY(SELECT user_id FROM task_assignees WHERE task_id = t.id ORDER BY assigned_at, user_id),
		       ARRAY(SELECT label_id FROM task_labels WHERE task_id = t.id)
		FROM tasks t WHERE id = $1 AND project_id = $2 FOR UPDATE`, taskID, projectID).
		Scan(&c.number, &c.title, &c.description, &c.statusID, &c.priority, &c.dueOn, &c.sprintID, &c.rank, &c.createdBy,
			&c.assignees, &c.labels)
	if isNoRows(err) {
		return nil, httpx.ErrNotFound
	}
	return &c, err
}

// UpdateTask changes a task. A new statusId without a rank puts the task at the end of
// that column; moving into a done status completes it, moving out reopens it.
func (s *Service) UpdateTask(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.editableProject(r)
	if err != nil {
		return err
	}
	taskID, err := taskIDFromRequest(r)
	if err != nil {
		return err
	}
	if !s.taskWrites.Allow(m.UserID.String()) {
		return errTooFast
	}
	var in taskInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	changed := false
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		cur, err := lockTask(ctx, tx, p.ID, taskID)
		if err != nil {
			return err
		}
		v := cur.taskValues
		if err := in.validate(&v); err != nil {
			return err
		}
		if in.StatusID != nil {
			v.statusID = *in.StatusID
		}
		if err := checkReferences(ctx, tx, p.ID, &v); err != nil {
			return err
		}
		events, err := diffTask(ctx, tx, p.ID, &cur.taskValues, &v)
		if err != nil {
			return err
		}
		// A move within or between columns: the client's rank, or the end of the new column.
		if in.Rank != nil {
			v.rank = *in.Rank
		} else if v.statusID != cur.statusID {
			last, err := lastRank(ctx, tx, v.statusID)
			if err != nil {
				return err
			}
			v.rank = rankAfter(last)
		}
		if len(events) == 0 && v.rank == cur.rank {
			return nil
		}
		changed = true
		if _, err := tx.Exec(ctx, `
			UPDATE tasks SET title = $3, description = $4, status_id = $5, rank = $6, priority = $7, due_on = $8::date,
			       sprint_id = $9, updated_at = now(),
			       completed_at = CASE
			           WHEN (SELECT category FROM task_statuses WHERE id = $5) <> 'done' THEN NULL
			           ELSE coalesce(completed_at, now()) END
			WHERE id = $1 AND project_id = $2`,
			taskID, p.ID, v.title, v.description, v.statusID, v.rank, v.priority, v.dueOn, v.sprintID); err != nil {
			return err
		}
		if in.AssigneeIDs != nil {
			if err := setAssignees(ctx, tx, p.ID, taskID, v.assignees); err != nil {
				return err
			}
		}
		if in.LabelIDs != nil {
			if err := setLabels(ctx, tx, p.ID, taskID, v.labels); err != nil {
				return err
			}
		}
		for _, e := range events {
			if err := recordEvent(ctx, tx, p.ID, taskID, m.UserID, e.kind, e.data); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if !changed {
		return s.respondTask(w, r, m, p, taskID, http.StatusOK)
	}
	return s.taskChanged(w, r, m, p, taskID, http.StatusOK)
}

type taskEvent struct {
	kind string
	data map[string]any
}

// diffTask lists the activity entries for a change from cur to v.
func diffTask(ctx context.Context, tx pgx.Tx, projectID uuid.UUID, cur, v *taskValues) ([]taskEvent, error) {
	var events []taskEvent
	add := func(kind string, data map[string]any) { events = append(events, taskEvent{kind, data}) }
	if v.title != cur.title {
		add("title_changed", map[string]any{"from": cur.title, "to": v.title})
	}
	if v.description != cur.description {
		add("description_changed", nil)
	}
	if v.statusID != cur.statusID {
		from, err := loadStatus(ctx, tx, projectID, cur.statusID)
		if err != nil {
			return nil, err
		}
		to, err := loadStatus(ctx, tx, projectID, v.statusID)
		if err != nil {
			return nil, httpx.Invalid(map[string]string{"statusId": "Choose a status of this project."})
		}
		add("status_changed", statusChange(*from, *to))
	}
	if v.priority != cur.priority {
		add("priority_changed", map[string]any{"from": cur.priority, "to": v.priority})
	}
	if !equalPtr(v.dueOn, cur.dueOn) {
		add("due_changed", map[string]any{"from": cur.dueOn, "to": v.dueOn})
	}
	if !equalPtr(v.sprintID, cur.sprintID) {
		from, err := sprintRef(ctx, tx, cur.sprintID)
		if err != nil {
			return nil, err
		}
		to, err := sprintRef(ctx, tx, v.sprintID)
		if err != nil {
			return nil, err
		}
		add("sprint_changed", map[string]any{"from": from, "to": to})
	}
	added, removed := diffIDs(cur.assignees, v.assignees)
	for _, p := range mustNames(ctx, tx, added) {
		add("assigned", map[string]any{"user": p})
	}
	for _, p := range mustNames(ctx, tx, removed) {
		add("unassigned", map[string]any{"user": p})
	}
	added, removed = diffIDs(cur.labels, v.labels)
	if len(added) > 0 || len(removed) > 0 {
		names := func(ids []uuid.UUID) []string {
			out := []string{}
			if len(ids) == 0 {
				return out
			}
			rows, err := tx.Query(ctx, `SELECT name FROM project_labels WHERE id = ANY ($1) ORDER BY lower(name)`, ids)
			if err == nil {
				out, _ = pgx.CollectRows(rows, pgx.RowTo[string])
			}
			return out
		}
		add("labels_changed", map[string]any{"added": names(added), "removed": names(removed)})
	}
	return events, nil
}

func sprintRef(ctx context.Context, q database.Querier, id *uuid.UUID) (map[string]any, error) {
	if id == nil {
		return nil, nil
	}
	var name string
	if err := q.QueryRow(ctx, `SELECT name FROM sprints WHERE id = $1`, *id).Scan(&name); err != nil {
		return nil, err
	}
	return map[string]any{"id": *id, "name": name}, nil
}

// mustNames names people for activity entries; unknown IDs are left out.
func mustNames(ctx context.Context, q database.Querier, ids []uuid.UUID) []Person {
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `SELECT id, display_name FROM users WHERE id = ANY ($1) ORDER BY lower(display_name), id`, ids)
	if err != nil {
		return nil
	}
	people, _ := pgx.CollectRows(rows, pgx.RowToStructByPos[Person])
	return people
}

func diffIDs(before, after []uuid.UUID) (added, removed []uuid.UUID) {
	for _, id := range after {
		if !slices.Contains(before, id) {
			added = append(added, id)
		}
	}
	for _, id := range before {
		if !slices.Contains(after, id) {
			removed = append(removed, id)
		}
	}
	return added, removed
}

func equalPtr[T comparable](a, b *T) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func recordEvent(ctx context.Context, q database.Querier, projectID, taskID, actorID uuid.UUID, kind string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	_, err := q.Exec(ctx, `
		INSERT INTO task_events (id, project_id, task_id, actor_id, kind, data) VALUES ($1, $2, $3, $4, $5, $6)`,
		uuid.Must(uuid.NewV7()), projectID, taskID, actorID, kind, data)
	return err
}

// DeleteTask removes a task with its comments and activity: its creator or a project
// manager. The deletion is audited.
func (s *Service) DeleteTask(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.editableProject(r)
	if err != nil {
		return err
	}
	taskID, err := taskIDFromRequest(r)
	if err != nil {
		return err
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		cur, err := lockTask(ctx, tx, p.ID, taskID)
		if err != nil {
			return err
		}
		if !p.CanManage && (cur.createdBy == nil || *cur.createdBy != m.UserID) {
			return httpx.ErrForbidden
		}
		if _, err := tx.Exec(ctx, `DELETE FROM tasks WHERE id = $1 AND project_id = $2`, taskID, p.ID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "task.deleted")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "task", taskID.String()
		ev.Metadata = map[string]any{"project": p.Name, "task": p.Key + "-" + strconv.Itoa(cur.number), "title": cur.title}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.publishProject(ctx, m.Org.ID, p.ID, realtime.Event{Type: "task.deleted", Data: map[string]any{
		"orgId": m.Org.ID, "projectId": p.ID, "taskId": taskID,
	}})
	httpx.NoContent(w)
	return nil
}

// ListMyTasks lists tasks across the projects the caller may see: ?q= searches titles
// and keys ("ENG-42") of active projects; otherwise the caller's assigned tasks that are
// open or were completed in the last seven days, soonest due first.
func (s *Service) ListMyTasks(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		return s.searchTasks(w, r, m, q)
	}
	tasks, err := queryVisibleTasks(r.Context(), s.db, m, `
		AND p.archived_at IS NULL
		AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = $2)
		AND (s.category <> 'done' OR t.completed_at > now() - interval '7 days')
		ORDER BY s.category = 'done', t.due_on NULLS LAST,
		         array_position(ARRAY['urgent', 'high', 'medium', 'low', 'none'], t.priority), t.created_at
		LIMIT 200`)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
	return nil
}

func (s *Service) searchTasks(w http.ResponseWriter, r *http.Request, m *org.Membership, q string) error {
	if len(q) > 100 {
		q = q[:100]
	}
	key, number := "", 0
	if k, n, ok := strings.Cut(strings.ToUpper(q), "-"); ok {
		if v, err := strconv.Atoi(n); err == nil {
			key, number = k, v
		}
	}
	pattern := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
	tasks, err := queryVisibleTasks(r.Context(), s.db, m, `
		AND p.archived_at IS NULL AND (t.title ILIKE $4 OR (p.key = $5 AND t.number = $6))
		ORDER BY p.key = $5 AND t.number = $6 DESC, s.category = 'done', t.updated_at DESC
		LIMIT 20`, pattern, key, number)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
	return nil
}

// ProjectActivity returns the project's latest task activity, newest first.
func (s *Service) ProjectActivity(w http.ResponseWriter, r *http.Request) error {
	m, p, err := projectFromRequest(r, s.db)
	if err != nil {
		return err
	}
	events, err := s.loadEvents(r.Context(), m, ` WHERE e.project_id = $1 ORDER BY e.id DESC LIMIT 50`, p.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"events": events})
	return nil
}
