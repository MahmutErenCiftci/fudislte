package projects

import (
	"context"
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

// Workflows and labels, edited by leads and project managers in the project settings.
// A status's category says what it means: tasks entering a "done" status are completed,
// tasks leaving one are reopened.

const (
	CategoryTodo       = "todo"
	CategoryInProgress = "in_progress"
	CategoryReview     = "review"
	CategoryDone       = "done"

	maxStatuses = 12
	maxLabels   = 50
)

var (
	errLastStatus    = httpx.NewError(http.StatusConflict, "last_status", "A project needs at least one status.")
	errTooManyStatus = httpx.NewError(http.StatusConflict, "too_many_statuses", "A project can have at most 12 statuses.")
	errTooManyLabels = httpx.NewError(http.StatusConflict, "too_many_labels", "A project can have at most 50 labels.")
	errStatusTaken   = httpx.Invalid(map[string]string{"name": "A status with this name already exists."})
	errLabelTaken    = httpx.Invalid(map[string]string{"name": "A label with this name already exists."})
	errStatusOrder   = httpx.Invalid(map[string]string{"statusIds": "List every status of the project once."})
	errChooseMoveTo  = httpx.Invalid(map[string]string{"moveTo": "Choose another status of this project for its tasks."})
)

func validCategory(c string) bool {
	return c == CategoryTodo || c == CategoryInProgress || c == CategoryReview || c == CategoryDone
}

type Status struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Category string    `json:"category"`
	Color    string    `json:"color"`
	Position int       `json:"position"`
}

type Label struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Color string    `json:"color"`
}

func loadStatuses(ctx context.Context, q database.Querier, projectID uuid.UUID) ([]Status, error) {
	rows, err := q.Query(ctx, `SELECT id, name, category, color, position FROM task_statuses WHERE project_id = $1 ORDER BY position, id`, projectID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Status])
}

func loadLabels(ctx context.Context, q database.Querier, projectID uuid.UUID) ([]Label, error) {
	rows, err := q.Query(ctx, `SELECT id, name, color FROM project_labels WHERE project_id = $1 ORDER BY lower(name), id`, projectID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Label])
}

// statusInput is the body of POST and PATCH; absent fields keep their value.
type statusInput struct {
	Name     *string `json:"name"`
	Category *string `json:"category"`
	Color    *string `json:"color"`
}

func (in statusInput) validate(cur Status) (Status, error) {
	v := cur
	fields := map[string]string{}
	var msg string
	if in.Name != nil {
		if v.Name, msg = NormalizeLine(*in.Name, 40); msg != "" {
			fields["name"] = msg
		}
	}
	if in.Category != nil {
		if v.Category = *in.Category; !validCategory(v.Category) {
			fields["category"] = "Choose to do, in progress, in review or done."
		}
	}
	if in.Color != nil {
		if v.Color = *in.Color; !slices.Contains(Colors, v.Color) {
			fields["color"] = "Choose a color."
		}
	}
	if v.Name == "" && fields["name"] == "" {
		fields["name"] = lineLimits[40]
	}
	if len(fields) > 0 {
		return v, httpx.Invalid(fields)
	}
	return v, nil
}

func (s *Service) CreateStatus(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	var in statusInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	st, err := in.validate(Status{Category: CategoryTodo, Color: "slate"})
	if err != nil {
		return err
	}
	st.ID = uuid.Must(uuid.NewV7())
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*), coalesce(max(position) + 1, 0) FROM task_statuses WHERE project_id = $1`, p.ID).Scan(&count, &st.Position); err != nil {
			return err
		}
		if count >= maxStatuses {
			return errTooManyStatus
		}
		_, err := tx.Exec(ctx, `INSERT INTO task_statuses (id, project_id, name, category, color, position) VALUES ($1, $2, $3, $4, $5, $6)`,
			st.ID, p.ID, st.Name, st.Category, st.Color, st.Position)
		if database.IsUniqueViolation(err, "task_statuses_name_key") {
			return errStatusTaken
		}
		return err
	})
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"status": st})
	return nil
}

// statusFromRequest loads the {statusID} status of the project.
func statusFromRequest(r *http.Request, q database.Querier, projectID uuid.UUID) (*Status, error) {
	id, err := uuid.Parse(chi.URLParam(r, "statusID"))
	if err != nil {
		return nil, httpx.ErrNotFound
	}
	return loadStatus(r.Context(), q, projectID, id)
}

func loadStatus(ctx context.Context, q database.Querier, projectID, id uuid.UUID) (*Status, error) {
	var st Status
	err := q.QueryRow(ctx, `SELECT id, name, category, color, position FROM task_statuses WHERE id = $1 AND project_id = $2`, id, projectID).
		Scan(&st.ID, &st.Name, &st.Category, &st.Color, &st.Position)
	if isNoRows(err) {
		return nil, httpx.ErrNotFound
	}
	return &st, err
}

// UpdateStatus renames a status or changes its color or category. Changing the
// category to or from done completes or reopens its tasks.
func (s *Service) UpdateStatus(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	cur, err := statusFromRequest(r, s.db, p.ID)
	if err != nil {
		return err
	}
	var in statusInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	st, err := in.validate(*cur)
	if err != nil {
		return err
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE task_statuses SET name = $3, category = $4, color = $5 WHERE id = $1 AND project_id = $2`,
			st.ID, p.ID, st.Name, st.Category, st.Color)
		if database.IsUniqueViolation(err, "task_statuses_name_key") {
			return errStatusTaken
		}
		if err != nil || (st.Category == CategoryDone) == (cur.Category == CategoryDone) {
			return err
		}
		_, err = tx.Exec(ctx, `
			UPDATE tasks SET completed_at = CASE WHEN $2 THEN now() END, updated_at = now() WHERE status_id = $1`,
			st.ID, st.Category == CategoryDone)
		return err
	})
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"status": st})
	return nil
}

// DeleteStatus removes a status; its tasks move to ?moveTo=, keeping their order, at
// the end of that column.
func (s *Service) DeleteStatus(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	st, err := statusFromRequest(r, s.db, p.ID)
	if err != nil {
		return err
	}
	var target *Status
	if v := r.URL.Query().Get("moveTo"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil || id == st.ID {
			return errChooseMoveTo
		}
		if target, err = loadStatus(ctx, s.db, p.ID, id); err != nil {
			return errChooseMoveTo
		}
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		var statuses, tasks int
		if err := tx.QueryRow(ctx, `
			SELECT (SELECT count(*) FROM task_statuses WHERE project_id = $1), (SELECT count(*) FROM tasks WHERE status_id = $2)`,
			p.ID, st.ID).Scan(&statuses, &tasks); err != nil {
			return err
		}
		if statuses <= 1 {
			return errLastStatus
		}
		if tasks > 0 {
			if target == nil {
				return errChooseMoveTo
			}
			if err := moveColumn(ctx, tx, m.UserID, p.ID, *st, *target); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `DELETE FROM task_statuses WHERE id = $1 AND project_id = $2`, st.ID, p.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	httpx.NoContent(w)
	return nil
}

// moveColumn moves every task of from to the end of to, in order, with activity entries.
func moveColumn(ctx context.Context, tx pgx.Tx, actorID, projectID uuid.UUID, from, to Status) error {
	last, err := lastRank(ctx, tx, to.ID)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM tasks WHERE status_id = $1 ORDER BY rank, id`, from.ID)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	ranks := make([]string, len(ids))
	events := make([]uuid.UUID, len(ids))
	for i := range ids {
		last = rankAfter(last)
		ranks[i] = last
		events[i] = uuid.Must(uuid.NewV7())
	}
	// Two statements for the whole column instead of two per task.
	if _, err := tx.Exec(ctx, `
		UPDATE tasks t SET status_id = $2, rank = u.rank, updated_at = now(),
		       completed_at = CASE WHEN NOT $4 THEN NULL ELSE coalesce(t.completed_at, now()) END
		FROM unnest($1::uuid[], $3::text[]) AS u (id, rank)
		WHERE t.id = u.id`, ids, to.ID, ranks, to.Category == CategoryDone); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO task_events (id, project_id, task_id, actor_id, kind, data)
		SELECT e.id, $3, e.task_id, $4, 'status_changed', $5
		FROM unnest($1::uuid[], $2::uuid[]) AS e (id, task_id)`,
		events, ids, projectID, actorID, statusChange(from, to))
	return err
}

func statusChange(from, to Status) map[string]any {
	ref := func(s Status) map[string]any {
		return map[string]any{"id": s.ID, "name": s.Name, "category": s.Category}
	}
	return map[string]any{"from": ref(from), "to": ref(to)}
}

// ReorderStatuses sets the column order: statusIds lists every status once.
func (s *Service) ReorderStatuses(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	var in struct {
		StatusIDs []uuid.UUID `json:"statusIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		current, err := loadStatuses(ctx, tx, p.ID)
		if err != nil {
			return err
		}
		if len(unique(in.StatusIDs)) != len(in.StatusIDs) || len(in.StatusIDs) != len(current) {
			return errStatusOrder
		}
		for _, st := range current {
			if !slices.Contains(in.StatusIDs, st.ID) {
				return errStatusOrder
			}
		}
		_, err = tx.Exec(ctx, `
			UPDATE task_statuses s SET position = o.n - 1
			FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, n)
			WHERE s.id = o.id AND s.project_id = $1`, p.ID, in.StatusIDs)
		return err
	})
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	statuses, err := loadStatuses(ctx, s.db, p.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"statuses": statuses})
	return nil
}

// lockProject serializes structural changes to one project (statuses, sprints).
func lockProject(ctx context.Context, tx pgx.Tx, projectID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT 1 FROM projects WHERE id = $1 FOR UPDATE`, projectID)
	return err
}

type labelInput struct {
	Name  *string `json:"name"`
	Color *string `json:"color"`
}

func (in labelInput) validate(cur Label) (Label, error) {
	v := cur
	fields := map[string]string{}
	var msg string
	if in.Name != nil {
		if v.Name, msg = NormalizeLine(*in.Name, 30); msg != "" {
			fields["name"] = msg
		}
	}
	if in.Color != nil {
		if v.Color = *in.Color; !slices.Contains(Colors, v.Color) {
			fields["color"] = "Choose a color."
		}
	}
	if v.Name == "" && fields["name"] == "" {
		fields["name"] = lineLimits[30]
	}
	if len(fields) > 0 {
		return v, httpx.Invalid(fields)
	}
	return v, nil
}

func (s *Service) CreateLabel(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	var in labelInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	l, err := in.validate(Label{Color: "blue"})
	if err != nil {
		return err
	}
	l.ID = uuid.Must(uuid.NewV7())
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM project_labels WHERE project_id = $1`, p.ID).Scan(&count); err != nil {
			return err
		}
		if count >= maxLabels {
			return errTooManyLabels
		}
		_, err := tx.Exec(ctx, `INSERT INTO project_labels (id, project_id, name, color) VALUES ($1, $2, $3, $4)`, l.ID, p.ID, l.Name, l.Color)
		if database.IsUniqueViolation(err, "project_labels_name_key") {
			return errLabelTaken
		}
		return err
	})
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"label": l})
	return nil
}

func labelFromRequest(r *http.Request, q database.Querier, projectID uuid.UUID) (*Label, error) {
	id, err := uuid.Parse(chi.URLParam(r, "labelID"))
	if err != nil {
		return nil, httpx.ErrNotFound
	}
	var l Label
	err = q.QueryRow(r.Context(), `SELECT id, name, color FROM project_labels WHERE id = $1 AND project_id = $2`, id, projectID).Scan(&l.ID, &l.Name, &l.Color)
	if isNoRows(err) {
		return nil, httpx.ErrNotFound
	}
	return &l, err
}

func (s *Service) UpdateLabel(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	cur, err := labelFromRequest(r, s.db, p.ID)
	if err != nil {
		return err
	}
	var in labelInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	l, err := in.validate(*cur)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `UPDATE project_labels SET name = $3, color = $4 WHERE id = $1 AND project_id = $2`, l.ID, p.ID, l.Name, l.Color)
	if database.IsUniqueViolation(err, "project_labels_name_key") {
		return errLabelTaken
	}
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"label": l})
	return nil
}

// DeleteLabel removes a label from the project and from every task.
func (s *Service) DeleteLabel(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	l, err := labelFromRequest(r, s.db, p.ID)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM project_labels WHERE id = $1 AND project_id = $2`, l.ID, p.ID); err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	httpx.NoContent(w)
	return nil
}
