package projects

import (
	"context"
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
)

// Project membership. Leads and project managers add and remove people and change
// roles; anyone who may view a public project joins it; everyone may leave. A project
// keeps at least one lead. Leaving a project — or the workspace — unassigns the person
// from its tasks (foreign key cascade). Every change is audited.

const maxProjectMembers = 1000

var errProjectFull = httpx.NewError(http.StatusConflict, "project_full", "A project can have at most 1000 members.")

func validRole(role string) bool { return role == RoleLead || role == RoleMember }

// AddMembers adds workspace members to the project with one role (default member);
// people already in it keep their role.
func (s *Service) AddMembers(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	var in struct {
		UserIDs []uuid.UUID `json:"userIds"`
		Role    string      `json:"role"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Role == "" {
		in.Role = RoleMember
	}
	ids := unique(in.UserIDs)
	fields := map[string]string{}
	if !validRole(in.Role) {
		fields["role"] = "Choose lead or member."
	}
	if len(ids) == 0 || len(ids) > maxMembersPerRequest {
		fields["userIds"] = "Choose 1 to 200 members."
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	var added []uuid.UUID
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if err := workspaceMembers(ctx, tx, m.Org.ID, ids); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			INSERT INTO project_members (project_id, org_id, user_id, role)
			SELECT $1, $2, u, $3 FROM unnest($4::uuid[]) AS u
			ON CONFLICT DO NOTHING RETURNING user_id`, p.ID, m.Org.ID, in.Role, ids)
		if err != nil {
			return err
		}
		if added, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID]); err != nil {
			return err
		}
		if err := checkSize(ctx, tx, p.ID); err != nil {
			return err
		}
		return s.auditMembers(r, tx, m, p, map[string]any{"added": added, "projectRole": in.Role})
	})
	if err != nil {
		return err
	}
	return s.membersChanged(w, r, m, p)
}

func checkSize(ctx context.Context, tx pgx.Tx, projectID uuid.UUID) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM project_members WHERE project_id = $1`, projectID).Scan(&n); err != nil {
		return err
	}
	if n > maxProjectMembers {
		return errProjectFull
	}
	return nil
}

// UpdateMember changes someone's project role.
func (s *Service) UpdateMember(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := s.managedProject(r)
	if err != nil {
		return err
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	var in struct {
		Role string `json:"role"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	if !validRole(in.Role) {
		return httpx.Invalid(map[string]string{"role": "Choose lead or member."})
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var before string
		err := tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE`, p.ID, userID).Scan(&before)
		if isNoRows(err) {
			return httpx.ErrNotFound
		}
		if err != nil || before == in.Role {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2`, p.ID, userID, in.Role); err != nil {
			return err
		}
		if err := keepLead(ctx, tx, p.ID); err != nil {
			return err
		}
		return s.auditMembers(r, tx, m, p, map[string]any{"changed": []uuid.UUID{userID}, "projectRole": in.Role})
	})
	if err != nil {
		return err
	}
	return s.membersChanged(w, r, m, p)
}

// RemoveMember takes someone off the project (leads and project managers), or lets the
// caller leave it.
func (s *Service) RemoveMember(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := projectFromRequest(r, s.db)
	if err != nil {
		return err
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	if userID != m.UserID && !p.CanManage {
		return httpx.ErrForbidden
	}
	if p.ArchivedAt != nil {
		return errArchived
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, p.ID, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.ErrNotFound
		}
		if err := keepLead(ctx, tx, p.ID); err != nil {
			return err
		}
		return s.auditMembers(r, tx, m, p, map[string]any{"removed": []uuid.UUID{userID}})
	})
	if err != nil {
		return err
	}
	// The person hears about it even when the project is private and they lost sight of it.
	s.projectChanged(ctx, m.Org.ID, p.ID, userID)
	if userID == m.UserID {
		httpx.NoContent(w)
		return nil
	}
	return s.respondMembers(w, r, p.ID)
}

// JoinProject adds the caller to a public project as a member.
func (s *Service) JoinProject(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, p, err := projectFromRequest(r, s.db)
	if err != nil {
		return err
	}
	if p.ArchivedAt != nil {
		return errArchived
	}
	if p.Role != "" {
		return s.respondMembers(w, r, p.ID)
	}
	if p.Visibility != VisibilityPublic || !m.Can(org.PermProjectsView) {
		return httpx.ErrForbidden
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO project_members (project_id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')
			ON CONFLICT DO NOTHING`, p.ID, m.Org.ID, m.UserID); err != nil {
			return err
		}
		if err := checkSize(ctx, tx, p.ID); err != nil {
			return err
		}
		return s.auditMembers(r, tx, m, p, map[string]any{"added": []uuid.UUID{m.UserID}, "projectRole": RoleMember})
	})
	if err != nil {
		return err
	}
	return s.membersChanged(w, r, m, p)
}

// keepLead fails when the change left the project without a lead.
func keepLead(ctx context.Context, tx pgx.Tx, projectID uuid.UUID) error {
	var leads int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM project_members WHERE project_id = $1 AND role = 'lead'`, projectID).Scan(&leads); err != nil {
		return err
	}
	if leads == 0 {
		return errLastLead
	}
	return nil
}

func (s *Service) auditMembers(r *http.Request, tx pgx.Tx, m *org.Membership, p *Project, meta map[string]any) error {
	for _, key := range []string{"added", "removed", "changed"} {
		if ids, ok := meta[key].([]uuid.UUID); ok && len(ids) == 0 {
			return nil // nothing changed
		}
	}
	ev := audit.FromRequest(r, "project.members_changed")
	ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
	ev.TargetType, ev.TargetID = "project", p.ID.String()
	meta["project"] = p.Name
	ev.Metadata = meta
	return audit.Record(r.Context(), tx, ev)
}

func (s *Service) membersChanged(w http.ResponseWriter, r *http.Request, m *org.Membership, p *Project) error {
	s.projectChanged(r.Context(), m.Org.ID, p.ID)
	return s.respondMembers(w, r, p.ID)
}

func (s *Service) respondMembers(w http.ResponseWriter, r *http.Request, projectID uuid.UUID) error {
	members, err := loadMembers(r.Context(), s.db, projectID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"members": members})
	return nil
}

// projectMembers fails unless every ID is a member of the project.
func projectMembers(ctx context.Context, q database.Querier, projectID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `SELECT user_id FROM project_members WHERE project_id = $1 AND user_id = ANY ($2)`, projectID, ids)
	if err != nil {
		return err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	for _, id := range ids {
		if !slices.Contains(found, id) {
			return httpx.Invalid(map[string]string{"assigneeIds": "Assign members of this project."})
		}
	}
	return nil
}
