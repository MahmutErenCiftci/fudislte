// Package projects implements projects, their workflows, tasks and sprints
// (docs/architecture/phase-5.md). Every handler runs behind org.RequireMember. Private
// projects are visible to their members only — workspace owners included — and answer
// 404 to everyone else; public ones to every member who may view projects.
package projects

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
	"fudislte/api/internal/org"
	"fudislte/api/internal/realtime"
)

type Service struct {
	db     *pgxpool.Pool
	events realtime.Publisher
	// taskWrites limits task changes per person; dragging cards produces bursts.
	taskWrites *httpx.Limiter
	// commentsByUser limits comments like messages.
	commentsByUser *httpx.Limiter
}

func NewService(db *pgxpool.Pool, events realtime.Publisher) *Service {
	return &Service{
		db:             db,
		events:         events,
		taskWrites:     httpx.NewLimiter(100*time.Millisecond, 60),
		commentsByUser: httpx.NewLimiter(200*time.Millisecond, 20),
	}
}

const (
	VisibilityPublic  = "public"
	VisibilityPrivate = "private"

	RoleLead   = "lead"
	RoleMember = "member"

	maxMembersPerRequest = 200
)

// Colors are the palette clients draw projects, statuses and labels with.
var Colors = []string{"slate", "red", "orange", "amber", "green", "emerald", "teal", "sky", "blue", "indigo", "violet", "pink"}

var (
	errKeyTaken   = httpx.Invalid(map[string]string{"key": "A project with this key already exists."})
	errArchived   = httpx.NewError(http.StatusConflict, "project_archived", "This project is archived. Restore it to make changes.")
	errNotMember  = httpx.NewError(http.StatusForbidden, "not_project_member", "Join the project to change its tasks.")
	errLastLead   = httpx.NewError(http.StatusConflict, "last_lead", "A project needs at least one lead.")
	errNotMembers = httpx.Invalid(map[string]string{"userIds": "Choose members of this workspace."})
)

// Person is someone shown by name.
type Person struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
}

// Project is what the caller sees of a project, with what they may do in it.
type Project struct {
	ID          uuid.UUID  `json:"id"`
	Key         string     `json:"key"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Color       string     `json:"color"`
	Visibility  string     `json:"visibility"`
	Status      string     `json:"status"`
	StartsOn    *string    `json:"startsOn"`
	EndsOn      *string    `json:"endsOn"`
	CreatedBy   *uuid.UUID `json:"createdBy"`
	CreatedAt   time.Time  `json:"createdAt"`
	ArchivedAt  *time.Time `json:"archivedAt"`
	MemberCount int        `json:"memberCount"`
	TaskCount   int        `json:"taskCount"`
	DoneCount   int        `json:"doneCount"`
	// People are the first members, leads first, for avatar stacks.
	People []Person `json:"people"`
	// Role is the caller's project role; empty for viewers of a public project.
	Role string `json:"role"`
	// CanEdit: create, edit and move tasks (members of an active project).
	CanEdit bool `json:"canEdit"`
	// CanManage: settings, workflow, labels, members, sprints and archiving (leads and
	// projects.manage).
	CanManage bool `json:"canManage"`
}

// ProjectRef names a project in lists that span projects.
type ProjectRef struct {
	ID    uuid.UUID `json:"id"`
	Key   string    `json:"key"`
	Name  string    `json:"name"`
	Color string    `json:"color"`
}

func (p *Project) Ref() ProjectRef {
	return ProjectRef{ID: p.ID, Key: p.Key, Name: p.Name, Color: p.Color}
}

// projectQuery loads the projects of workspace $1 that the caller ($2) may see; $3 is
// whether they may view public projects.
const projectQuery = `
	SELECT p.id, p.key, p.name, p.description, p.color, p.visibility,
	       to_char(p.starts_on, 'YYYY-MM-DD'), to_char(p.ends_on, 'YYYY-MM-DD'),
	       p.created_by, p.created_at, p.archived_at,
	       (SELECT count(*) FROM project_members x WHERE x.project_id = p.id),
	       (SELECT count(*) FROM tasks t WHERE t.project_id = p.id),
	       (SELECT count(*) FROM tasks t JOIN task_statuses s ON s.id = t.status_id
	        WHERE t.project_id = p.id AND s.category = 'done'),
	       coalesce(pm.role, '')
	FROM projects p
	LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
	WHERE p.org_id = $1 AND (pm.user_id IS NOT NULL OR (p.visibility = 'public' AND $3))`

func queryProjects(ctx context.Context, q database.Querier, m *org.Membership, filter string, args ...any) ([]Project, error) {
	rows, err := q.Query(ctx, projectQuery+filter, append([]any{m.Org.ID, m.UserID, m.Can(org.PermProjectsView)}, args...)...)
	if err != nil {
		return nil, err
	}
	projects, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Project, error) {
		var p Project
		err := row.Scan(&p.ID, &p.Key, &p.Name, &p.Description, &p.Color, &p.Visibility, &p.StartsOn, &p.EndsOn,
			&p.CreatedBy, &p.CreatedAt, &p.ArchivedAt, &p.MemberCount, &p.TaskCount, &p.DoneCount, &p.Role)
		return p, err
	})
	if err != nil {
		return nil, err
	}
	for i := range projects {
		projects[i].settle(m)
	}
	return projects, fillPeople(ctx, q, projects)
}

// settle works out the status and what the caller may do.
func (p *Project) settle(m *org.Membership) {
	p.Status = "active"
	if p.ArchivedAt != nil {
		p.Status = "archived"
	}
	p.CanManage = p.Role == RoleLead || m.Can(org.PermProjectsManage)
	p.CanEdit = p.Role != "" && p.ArchivedAt == nil
}

// fillPeople names up to five members of each project, leads first.
func fillPeople(ctx context.Context, q database.Querier, projects []Project) error {
	if len(projects) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(projects))
	index := make(map[uuid.UUID]int, len(projects))
	for i := range projects {
		ids[i] = projects[i].ID
		index[projects[i].ID] = i
		projects[i].People = []Person{}
	}
	rows, err := q.Query(ctx, `
		SELECT x.project_id, x.id, x.display_name FROM (
		    SELECT pm.project_id, u.id, u.display_name,
		           row_number() OVER (PARTITION BY pm.project_id ORDER BY pm.role = 'lead' DESC, lower(u.display_name), u.id) AS n
		    FROM project_members pm JOIN users u ON u.id = pm.user_id
		    WHERE pm.project_id = ANY ($1)) x
		WHERE x.n <= 5 ORDER BY x.project_id, x.n`, ids)
	if err != nil {
		return err
	}
	var (
		projectID uuid.UUID
		person    Person
	)
	_, err = pgx.ForEachRow(rows, []any{&projectID, &person.ID, &person.DisplayName}, func() error {
		i := index[projectID]
		projects[i].People = append(projects[i].People, person)
		return nil
	})
	return err
}

// Load returns project id of the caller's workspace if the caller may see it, and
// httpx.ErrNotFound otherwise. Whiteboards use it for their own access.
func Load(ctx context.Context, q database.Querier, m *org.Membership, id uuid.UUID) (*Project, error) {
	projects, err := queryProjects(ctx, q, m, ` AND p.id = $4`, id)
	if err != nil {
		return nil, err
	}
	if len(projects) == 0 {
		return nil, httpx.ErrNotFound
	}
	return &projects[0], nil
}

// LoadMany returns, by ID, the projects among ids that the caller may see.
func LoadMany(ctx context.Context, q database.Querier, m *org.Membership, ids []uuid.UUID) (map[uuid.UUID]*Project, error) {
	out := map[uuid.UUID]*Project{}
	if len(ids) == 0 {
		return out, nil
	}
	projects, err := queryProjects(ctx, q, m, ` AND p.id = ANY ($4)`, unique(ids))
	if err != nil {
		return nil, err
	}
	for i := range projects {
		out[projects[i].ID] = &projects[i]
	}
	return out, nil
}

// CanSee returns those of userIDs who may see the project now: its members and, for a
// public project, everyone in the workspace whose role may view projects.
func CanSee(ctx context.Context, q database.Querier, orgID, projectID uuid.UUID, userIDs []uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx, `
		SELECT pm.user_id FROM project_members pm
		WHERE pm.project_id = $2 AND pm.user_id = ANY ($3)
		UNION
		SELECT m.user_id FROM memberships m
		JOIN roles r ON r.id = m.role_id
		JOIN projects p ON p.id = $2 AND p.org_id = m.org_id AND p.visibility = 'public'
		WHERE m.org_id = $1 AND m.user_id = ANY ($3) AND 'projects.view' = ANY (r.permissions)`,
		orgID, projectID, userIDs)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// viewers returns everyone who may see the project now: who receives its live events.
func viewers(ctx context.Context, q database.Querier, orgID, projectID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx, `
		SELECT user_id FROM project_members WHERE project_id = $2
		UNION
		SELECT m.user_id FROM memberships m
		JOIN roles r ON r.id = m.role_id
		JOIN projects p ON p.id = $2 AND p.org_id = m.org_id AND p.visibility = 'public'
		WHERE m.org_id = $1 AND 'projects.view' = ANY (r.permissions)`, orgID, projectID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// publishProject sends ev to everyone who may see the project, and to also (people who
// just lost access). Call it after the change has committed; a failure only delays
// clients until their next refetch.
func (s *Service) publishProject(ctx context.Context, orgID, projectID uuid.UUID, ev realtime.Event, also ...uuid.UUID) {
	ids, err := viewers(ctx, s.db, orgID, projectID)
	if err != nil {
		return
	}
	s.events.Publish(unique(append(ids, also...)), ev)
}

// projectChanged tells everyone concerned to refetch the project.
func (s *Service) projectChanged(ctx context.Context, orgID, projectID uuid.UUID, also ...uuid.UUID) {
	s.publishProject(ctx, orgID, projectID, realtime.Event{Type: "project.updated", Data: map[string]any{
		"orgId": orgID, "projectId": projectID,
	}}, also...)
}

// projectFromRequest loads the {projectID} project for the calling member.
func projectFromRequest(r *http.Request, q database.Querier) (*org.Membership, *Project, error) {
	m := org.MembershipFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "projectID"))
	if err != nil {
		return m, nil, httpx.ErrNotFound
	}
	p, err := Load(r.Context(), q, m, id)
	return m, p, err
}

// managedProject is projectFromRequest for what only leads and project managers may do
// in an active project.
func (s *Service) managedProject(r *http.Request) (*org.Membership, *Project, error) {
	m, p, err := projectFromRequest(r, s.db)
	switch {
	case err != nil:
	case !p.CanManage:
		err = httpx.ErrForbidden
	case p.ArchivedAt != nil:
		err = errArchived
	}
	return m, p, err
}

// editableProject is projectFromRequest for changes to tasks: members of an active
// project only.
func (s *Service) editableProject(r *http.Request) (*org.Membership, *Project, error) {
	m, p, err := projectFromRequest(r, s.db)
	switch {
	case err != nil:
	case p.ArchivedAt != nil:
		err = errArchived
	case p.Role == "":
		err = errNotMember
	}
	return m, p, err
}

// ListProjects returns the projects the caller may see, active ones first; with
// ?archived=true only archived ones.
func (s *Service) ListProjects(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	filter := ` AND p.archived_at IS NULL`
	if r.URL.Query().Get("archived") == "true" {
		filter = ` AND p.archived_at IS NOT NULL`
	}
	projects, err := queryProjects(r.Context(), s.db, m, filter+` ORDER BY lower(p.name), p.id`)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"projects": projects})
	return nil
}

// ProjectDetail is a project with its members, workflow, labels and sprints.
type ProjectDetail struct {
	Project
	Members  []Member `json:"members"`
	Statuses []Status `json:"statuses"`
	Labels   []Label  `json:"labels"`
	Sprints  []Sprint `json:"sprints"`
}

type Member struct {
	User    Person    `json:"user"`
	Role    string    `json:"role"`
	AddedAt time.Time `json:"addedAt"`
}

func (s *Service) GetProject(w http.ResponseWriter, r *http.Request) error {
	_, p, err := projectFromRequest(r, s.db)
	if err != nil {
		return err
	}
	return s.respondProject(w, r, p, http.StatusOK)
}

func (s *Service) respondProject(w http.ResponseWriter, r *http.Request, p *Project, status int) error {
	ctx := r.Context()
	d := ProjectDetail{Project: *p}
	var err error
	if d.Members, err = loadMembers(ctx, s.db, p.ID); err != nil {
		return err
	}
	if d.Statuses, err = loadStatuses(ctx, s.db, p.ID); err != nil {
		return err
	}
	if d.Labels, err = loadLabels(ctx, s.db, p.ID); err != nil {
		return err
	}
	if d.Sprints, err = loadSprints(ctx, s.db, p.ID); err != nil {
		return err
	}
	httpx.WriteJSON(w, status, map[string]any{"project": d})
	return nil
}

func loadMembers(ctx context.Context, q database.Querier, projectID uuid.UUID) ([]Member, error) {
	rows, err := q.Query(ctx, `
		SELECT u.id, u.display_name, pm.role, pm.added_at
		FROM project_members pm JOIN users u ON u.id = pm.user_id
		WHERE pm.project_id = $1
		ORDER BY pm.role = 'lead' DESC, lower(u.display_name), u.id`, projectID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Member, error) {
		var mb Member
		err := row.Scan(&mb.User.ID, &mb.User.DisplayName, &mb.Role, &mb.AddedAt)
		return mb, err
	})
}

// projectInput is the body of POST and PATCH; absent fields keep their value.
type projectInput struct {
	Key         *string          `json:"key"`
	Name        *string          `json:"name"`
	Description *string          `json:"description"`
	Color       *string          `json:"color"`
	Visibility  *string          `json:"visibility"`
	StartsOn    optional[string] `json:"startsOn"`
	EndsOn      optional[string] `json:"endsOn"`
}

type projectValues struct {
	key, name, description, color, visibility string
	startsOn, endsOn                          *string
}

func (in projectInput) validate(cur projectValues) (projectValues, error) {
	v := cur
	fields := map[string]string{}
	var msg string
	if in.Key != nil {
		if v.key, msg = normalizeKey(*in.Key); msg != "" {
			fields["key"] = msg
		}
	}
	if in.Name != nil {
		if v.name, msg = NormalizeLine(*in.Name, 80); msg != "" {
			fields["name"] = msg
		}
	}
	if in.Description != nil {
		if v.description, msg = NormalizeText(*in.Description, 2000); msg != "" {
			fields["description"] = msg
		}
	}
	if in.Color != nil {
		if v.color = *in.Color; !slices.Contains(Colors, v.color) {
			fields["color"] = "Choose a color."
		}
	}
	if in.Visibility != nil {
		if v.visibility = *in.Visibility; v.visibility != VisibilityPublic && v.visibility != VisibilityPrivate {
			fields["visibility"] = "Choose public or private."
		}
	}
	if in.StartsOn.Set {
		if v.startsOn, msg = normalizeDate(in.StartsOn.Value); msg != "" {
			fields["startsOn"] = msg
		}
	}
	if in.EndsOn.Set {
		if v.endsOn, msg = normalizeDate(in.EndsOn.Value); msg != "" {
			fields["endsOn"] = msg
		}
	}
	if v.startsOn != nil && v.endsOn != nil && *v.endsOn < *v.startsOn && fields["endsOn"] == "" {
		fields["endsOn"] = "The end cannot be before the start."
	}
	if v.key == "" && fields["key"] == "" {
		fields["key"] = "Use 2 to 6 letters from A to Z."
	}
	if v.name == "" && fields["name"] == "" {
		fields["name"] = "Use 1 to 80 characters."
	}
	if len(fields) > 0 {
		return v, httpx.Invalid(fields)
	}
	return v, nil
}

// defaultStatuses are a new project's workflow, named in the creator's language.
var defaultStatuses = []struct{ name, category, color string }{
	{"To Do", "todo", "slate"},
	{"In Progress", "in_progress", "blue"},
	{"In Review", "review", "amber"},
	{"Done", "done", "green"},
}

// CreateProject creates a project led by the caller, with the default workflow.
// memberIds become members.
func (s *Service) CreateProject(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	var in struct {
		projectInput
		MemberIDs []uuid.UUID `json:"memberIds"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	v, err := in.validate(projectValues{color: "blue", visibility: VisibilityPublic})
	if err != nil {
		return err
	}
	members := slices.DeleteFunc(unique(in.MemberIDs), func(id uuid.UUID) bool { return id == m.UserID })
	if len(members) > maxMembersPerRequest {
		return httpx.Invalid(map[string]string{"memberIds": "Add at most 200 members at once."})
	}
	id := uuid.Must(uuid.NewV7())
	locale := i18n.FromContext(ctx)
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := workspaceMembers(ctx, tx, m.Org.ID, members); err != nil {
			return httpx.Invalid(map[string]string{"memberIds": "Choose members of this workspace."})
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO projects (id, org_id, key, name, description, color, visibility, starts_on, ends_on, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10)`,
			id, m.Org.ID, v.key, v.name, v.description, v.color, v.visibility, v.startsOn, v.endsOn, m.UserID)
		if database.IsUniqueViolation(err, "projects_org_key_key") {
			return errKeyTaken
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO project_members (project_id, org_id, user_id, role) VALUES ($1, $2, $3, 'lead')`, id, m.Org.ID, m.UserID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO project_members (project_id, org_id, user_id, role)
			SELECT $1, $2, u, 'member' FROM unnest($3::uuid[]) AS u`, id, m.Org.ID, members); err != nil {
			return err
		}
		for i, st := range defaultStatuses {
			if _, err := tx.Exec(ctx, `
				INSERT INTO task_statuses (id, project_id, name, category, color, position) VALUES ($1, $2, $3, $4, $5, $6)`,
				uuid.Must(uuid.NewV7()), id, i18n.T(locale, st.name), st.category, st.color, i); err != nil {
				return err
			}
		}
		ev := audit.FromRequest(r, "project.created")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "project", id.String()
		ev.Metadata = map[string]any{"project": v.name, "key": v.key, "visibility": v.visibility, "added": append([]uuid.UUID{m.UserID}, members...)}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	p, err := Load(ctx, s.db, m, id)
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, id)
	return s.respondProject(w, r, p, http.StatusCreated)
}

// UpdateProject changes a project's settings (leads and project managers). Making a
// project private hides it at once from everyone who is not a member.
func (s *Service) UpdateProject(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	var in projectInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	cur := projectValues{key: p.Key, name: p.Name, description: p.Description, color: p.Color, visibility: p.Visibility,
		startsOn: p.StartsOn, endsOn: p.EndsOn}
	v, err := in.validate(cur)
	if err != nil {
		return err
	}
	// Everyone who could see the project before hears about it, so people who lose
	// access drop it at once.
	before, err := viewers(ctx, s.db, m.Org.ID, p.ID)
	if err != nil {
		return err
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE projects SET key = $3, name = $4, description = $5, color = $6, visibility = $7,
			       starts_on = $8::date, ends_on = $9::date
			WHERE id = $1 AND org_id = $2`,
			p.ID, m.Org.ID, v.key, v.name, v.description, v.color, v.visibility, v.startsOn, v.endsOn)
		if database.IsUniqueViolation(err, "projects_org_key_key") {
			return errKeyTaken
		}
		if err != nil {
			return err
		}
		changes := map[string]any{}
		if v.name != p.Name {
			changes["name"] = map[string]string{"from": p.Name, "to": v.name}
		}
		if v.key != p.Key {
			changes["key"] = map[string]string{"from": p.Key, "to": v.key}
		}
		if v.visibility != p.Visibility {
			changes["visibility"] = map[string]string{"from": p.Visibility, "to": v.visibility}
		}
		if len(changes) == 0 {
			return nil
		}
		changes["project"] = v.name
		ev := audit.FromRequest(r, "project.updated")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "project", p.ID.String()
		ev.Metadata = changes
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID, before...)
	updated, err := Load(ctx, s.db, m, p.ID)
	if err != nil {
		return err
	}
	return s.respondProject(w, r, updated, http.StatusOK)
}

// ArchiveProject makes a project read-only; UnarchiveProject restores it.
func (s *Service) ArchiveProject(w http.ResponseWriter, r *http.Request) error {
	return s.setArchived(w, r, true)
}

func (s *Service) UnarchiveProject(w http.ResponseWriter, r *http.Request) error {
	return s.setArchived(w, r, false)
}

func (s *Service) setArchived(w http.ResponseWriter, r *http.Request, archived bool) error {
	ctx := r.Context()
	m, p, err := projectFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if !p.CanManage {
		return httpx.ErrForbidden
	}
	if (p.ArchivedAt != nil) == archived {
		return s.respondProject(w, r, p, http.StatusOK)
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE projects SET archived_at = CASE WHEN $3 THEN now() END WHERE id = $1 AND org_id = $2`,
			p.ID, m.Org.ID, archived); err != nil {
			return err
		}
		action := "project.restored"
		if archived {
			action = "project.archived"
		}
		ev := audit.FromRequest(r, action)
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "project", p.ID.String()
		ev.Metadata = map[string]any{"project": p.Name}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.projectChanged(ctx, m.Org.ID, p.ID)
	updated, err := Load(ctx, s.db, m, p.ID)
	if err != nil {
		return err
	}
	return s.respondProject(w, r, updated, http.StatusOK)
}
