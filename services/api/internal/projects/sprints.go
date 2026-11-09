package projects

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

// Sprints, planned and run by leads and project managers. A project has at most one
// active sprint. Completing it moves its unfinished tasks back to the backlog (no
// sprint); finished tasks keep it. Deleting a sprint that is not completed also sends
// its tasks to the backlog.

const (
	SprintPlanned   = "planned"
	SprintActive    = "active"
	SprintCompleted = "completed"
)

var (
	errSprintActive    = httpx.NewError(http.StatusConflict, "sprint_active", "Complete the active sprint first.")
	errSprintState     = httpx.NewError(http.StatusConflict, "sprint_state", "This sprint cannot do that in its current state.")
	errSprintCompleted = httpx.NewError(http.StatusConflict, "sprint_completed", "Completed sprints cannot be changed.")
)

type Sprint struct {
	ID          uuid.UUID  `json:"id"`
	Name        string     `json:"name"`
	Goal        string     `json:"goal"`
	StartsOn    *string    `json:"startsOn"`
	EndsOn      *string    `json:"endsOn"`
	State       string     `json:"state"`
	CreatedAt   time.Time  `json:"createdAt"`
	CompletedAt *time.Time `json:"completedAt"`
	TaskCount   int        `json:"taskCount"`
	DoneCount   int        `json:"doneCount"`
}

const sprintQuery = `
	SELECT sp.id, sp.name, sp.goal, to_char(sp.starts_on, 'YYYY-MM-DD'), to_char(sp.ends_on, 'YYYY-MM-DD'), sp.state,
	       sp.created_at, sp.completed_at,
	       (SELECT count(*) FROM tasks t WHERE t.sprint_id = sp.id),
	       (SELECT count(*) FROM tasks t JOIN task_statuses s ON s.id = t.status_id WHERE t.sprint_id = sp.id AND s.category = 'done')
	FROM sprints sp`

// loadSprints returns the active sprint, then planned ones in creation order, then
// completed ones, latest first.
func loadSprints(ctx context.Context, q database.Querier, projectID uuid.UUID) ([]Sprint, error) {
	return querySprints(ctx, q, ` WHERE sp.project_id = $1
		ORDER BY array_position(ARRAY['active', 'planned', 'completed'], sp.state), sp.completed_at DESC NULLS FIRST, sp.created_at, sp.id`, projectID)
}

func querySprints(ctx context.Context, q database.Querier, filter string, args ...any) ([]Sprint, error) {
	rows, err := q.Query(ctx, sprintQuery+filter, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Sprint])
}

type sprintInput struct {
	Name     *string          `json:"name"`
	Goal     *string          `json:"goal"`
	StartsOn optional[string] `json:"startsOn"`
	EndsOn   optional[string] `json:"endsOn"`
}

func (in sprintInput) validate(cur Sprint) (Sprint, error) {
	v := cur
	fields := map[string]string{}
	var msg string
	if in.Name != nil {
		if v.Name, msg = NormalizeLine(*in.Name, 80); msg != "" {
			fields["name"] = msg
		}
	}
	if in.Goal != nil {
		if v.Goal, msg = NormalizeText(*in.Goal, 500); msg != "" {
			fields["goal"] = msg
		}
	}
	if in.StartsOn.Set {
		if v.StartsOn, msg = normalizeDate(in.StartsOn.Value); msg != "" {
			fields["startsOn"] = msg
		}
	}
	if in.EndsOn.Set {
		if v.EndsOn, msg = normalizeDate(in.EndsOn.Value); msg != "" {
			fields["endsOn"] = msg
		}
	}
	if v.StartsOn != nil && v.EndsOn != nil && *v.EndsOn < *v.StartsOn && fields["endsOn"] == "" {
		fields["endsOn"] = "The end cannot be before the start."
	}
	if v.Name == "" && fields["name"] == "" {
		fields["name"] = lineLimits[80]
	}
	if len(fields) > 0 {
		return v, httpx.Invalid(fields)
	}
	return v, nil
}

func (s *Service) CreateSprint(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	var in sprintInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	sp, err := in.validate(Sprint{})
	if err != nil {
		return err
	}
	id := uuid.Must(uuid.NewV7())
	if _, err := s.db.Exec(ctx, `
		INSERT INTO sprints (id, project_id, name, goal, starts_on, ends_on) VALUES ($1, $2, $3, $4, $5::date, $6::date)`,
		id, p.ID, sp.Name, sp.Goal, sp.StartsOn, sp.EndsOn); err != nil {
		return err
	}
	return s.sprintChanged(w, r, m.Org.ID, p.ID, id, http.StatusCreated)
}

func (s *Service) sprintChanged(w http.ResponseWriter, r *http.Request, orgID, projectID, sprintID uuid.UUID, status int) error {
	s.projectChanged(r.Context(), orgID, projectID)
	sprints, err := querySprints(r.Context(), s.db, ` WHERE sp.id = $1`, sprintID)
	if err != nil {
		return err
	}
	if len(sprints) == 0 {
		return httpx.ErrNotFound
	}
	httpx.WriteJSON(w, status, map[string]any{"sprint": sprints[0]})
	return nil
}

// sprintFromRequest loads the {sprintID} sprint of the project.
func (s *Service) sprintFromRequest(r *http.Request, q database.Querier, projectID uuid.UUID) (*Sprint, error) {
	id, err := uuid.Parse(chi.URLParam(r, "sprintID"))
	if err != nil {
		return nil, httpx.ErrNotFound
	}
	sprints, err := querySprints(r.Context(), q, ` WHERE sp.id = $1 AND sp.project_id = $2`, id, projectID)
	if err != nil {
		return nil, err
	}
	if len(sprints) == 0 {
		return nil, httpx.ErrNotFound
	}
	return &sprints[0], nil
}

func (s *Service) UpdateSprint(w http.ResponseWriter, r *http.Request) error {
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	cur, err := s.sprintFromRequest(r, s.db, p.ID)
	if err != nil {
		return err
	}
	if cur.State == SprintCompleted {
		return errSprintCompleted
	}
	var in sprintInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	sp, err := in.validate(*cur)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `
		UPDATE sprints SET name = $3, goal = $4, starts_on = $5::date, ends_on = $6::date WHERE id = $1 AND project_id = $2`,
		sp.ID, p.ID, sp.Name, sp.Goal, sp.StartsOn, sp.EndsOn); err != nil {
		return err
	}
	return s.sprintChanged(w, r, m.Org.ID, p.ID, sp.ID, http.StatusOK)
}

// StartSprint makes a planned sprint the active one; it starts today unless it has a
// start date.
func (s *Service) StartSprint(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	sp, err := s.sprintFromRequest(r, s.db, p.ID)
	if err != nil {
		return err
	}
	if sp.State != SprintPlanned {
		return errSprintState
	}
	_, err = s.db.Exec(ctx, `
		UPDATE sprints SET state = 'active', starts_on = coalesce(starts_on, current_date)
		WHERE id = $1 AND project_id = $2 AND state = 'planned'`, sp.ID, p.ID)
	if database.IsUniqueViolation(err, "sprints_one_active_key") {
		return errSprintActive
	}
	if err != nil {
		return err
	}
	return s.sprintChanged(w, r, m.Org.ID, p.ID, sp.ID, http.StatusOK)
}

// CompleteSprint ends the active sprint and moves its unfinished tasks to the backlog.
func (s *Service) CompleteSprint(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	sp, err := s.sprintFromRequest(r, s.db, p.ID)
	if err != nil {
		return err
	}
	if sp.State != SprintActive {
		return errSprintState
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE sprints SET state = 'completed', completed_at = now(), ends_on = coalesce(ends_on, current_date)
			WHERE id = $1 AND project_id = $2 AND state = 'active'`, sp.ID, p.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errSprintState
		}
		return toBacklog(ctx, tx, m.UserID, p.ID, sp, `AND s.category <> 'done'`)
	})
	if err != nil {
		return err
	}
	return s.sprintChanged(w, r, m.Org.ID, p.ID, sp.ID, http.StatusOK)
}

// toBacklog takes the sprint's tasks matching filter out of it, with activity entries.
func toBacklog(ctx context.Context, tx pgx.Tx, actorID, projectID uuid.UUID, sp *Sprint, filter string) error {
	rows, err := tx.Query(ctx, `
		UPDATE tasks t SET sprint_id = NULL, updated_at = now()
		FROM task_statuses s
		WHERE s.id = t.status_id AND t.sprint_id = $1 `+filter+`
		RETURNING t.id`, sp.ID)
	if err != nil {
		return err
	}
	moved, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	from := map[string]any{"id": sp.ID, "name": sp.Name}
	for _, id := range moved {
		if err := recordEvent(ctx, tx, projectID, id, actorID, "sprint_changed", map[string]any{"from": from, "to": nil}); err != nil {
			return err
		}
	}
	return nil
}

// DeleteSprint removes a planned or active sprint; its tasks return to the backlog.
func (s *Service) DeleteSprint(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	sp, err := s.sprintFromRequest(r, s.db, p.ID)
	if err != nil {
		return err
	}
	if sp.State == SprintCompleted {
		return errSprintCompleted
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := toBacklog(ctx, tx, m.UserID, p.ID, sp, ""); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM sprints WHERE id = $1 AND project_id = $2`, sp.ID, p.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	httpx.NoContent(w)
	return nil
}
