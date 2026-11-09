package org

import (
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

type RoleSummary struct {
	Role
	MemberCount int `json:"memberCount"`
}

var (
	errRoleImmutable = httpx.NewError(http.StatusConflict, "role_immutable", "The Owner role cannot be changed.")
	errRoleOutranked = httpx.NewError(http.StatusForbidden, "forbidden", "You can only change roles that rank below yours.")
	errGrantHeld     = httpx.NewError(http.StatusForbidden, "forbidden", "You can only grant permissions your own role has.")
)

func (s *Service) ListRoles(w http.ResponseWriter, r *http.Request) error {
	m := mustMembership(r.Context())
	rows, err := s.db.Query(r.Context(), `
		SELECT `+roleColumns+`, (SELECT count(*) FROM memberships mm WHERE mm.role_id = r.id)
		FROM roles r WHERE r.org_id = $1
		ORDER BY r.position DESC, r.name`, m.Org.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	roles := []RoleSummary{}
	for rows.Next() {
		var rs RoleSummary
		if rs.Role, err = scanRole(rows, &rs.MemberCount); err != nil {
			return err
		}
		roles = append(roles, rs)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"roles": roles})
	return nil
}

type roleInput struct {
	Name        *string       `json:"name"`
	Description *string       `json:"description"`
	Position    *int          `json:"position"`
	Permissions *[]Permission `json:"permissions"`
}

// apply validates the provided fields and copies them onto role. It enforces that a
// non-owner can neither rank a role at or above their own nor grant permissions they
// do not hold.
func (in roleInput) apply(actor *Membership, role *Role) error {
	fields := map[string]string{}
	if in.Name != nil {
		name := strings.Join(strings.Fields(*in.Name), " ")
		if n := utf8.RuneCountInString(name); n < 1 || n > 40 {
			fields["name"] = "Use 1 to 40 characters."
		}
		role.Name = name
	}
	if in.Description != nil {
		desc := strings.TrimSpace(*in.Description)
		if utf8.RuneCountInString(desc) > 200 {
			fields["description"] = "Use at most 200 characters."
		}
		role.Description = desc
	}
	if in.Position != nil {
		switch {
		case *in.Position < 1 || *in.Position > MaxRolePosition:
			fields["position"] = "Choose a rank between 1 and 99."
		case !actor.IsOwner() && *in.Position >= actor.Role.Position:
			fields["position"] = "Choose a rank below your own role."
		}
		role.Position = *in.Position
	}
	if in.Permissions != nil {
		perms := []Permission{}
		for _, p := range *in.Permissions {
			if !IsKnownPermission(p) {
				fields["permissions"] = "Unknown permission."
				break
			}
			if !slices.Contains(perms, p) {
				perms = append(perms, p)
			}
		}
		role.Permissions = perms
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	if in.Permissions != nil && !actor.IsOwner() {
		for _, p := range role.Permissions {
			if !actor.Can(p) {
				return errGrantHeld
			}
		}
	}
	return nil
}

func (s *Service) CreateRole(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	var in roleInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	missing := map[string]string{}
	if in.Name == nil {
		missing["name"] = "Enter a name."
	}
	if in.Position == nil {
		missing["position"] = "Choose a rank."
	}
	if len(missing) > 0 {
		return httpx.Invalid(missing)
	}
	if in.Permissions == nil {
		in.Permissions = &[]Permission{}
	}
	role := Role{ID: uuid.Must(uuid.NewV7()), Key: "custom-" + randomHex(4)}
	if err := in.apply(actor, &role); err != nil {
		return err
	}
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO roles (id, org_id, key, name, description, position, permissions)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			role.ID, actor.Org.ID, role.Key, role.Name, role.Description, role.Position, permissionStrings(role.Permissions))
		if database.IsUniqueViolation(err, "roles_org_name_key") {
			return httpx.Invalid(map[string]string{"name": "A role with this name already exists."})
		}
		if err != nil {
			return err
		}
		ev := audit.FromRequest(r, "role.created")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "role", role.ID.String()
		ev.Metadata = map[string]any{"name": role.Name, "position": role.Position, "permissions": role.Permissions}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"role": role})
	return nil
}

func (s *Service) UpdateRole(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	roleID, err := uuid.Parse(chi.URLParam(r, "roleID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	var in roleInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	var role *Role
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if role, err = loadRole(ctx, tx, actor.Org.ID, roleID); err != nil {
			return err
		}
		switch {
		case role == nil:
			return httpx.ErrNotFound
		case role.IsSystem:
			return errRoleImmutable
		case !actor.Outranks(role.Position):
			return errRoleOutranked
		}
		before := *role
		if err := in.apply(actor, role); err != nil {
			return err
		}
		if hasManagementPermission(role.Permissions) {
			var usedByDomain bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM organization_domains WHERE role_id = $1)`, role.ID).Scan(&usedByDomain); err != nil {
				return err
			}
			if usedByDomain {
				return httpx.Invalid(map[string]string{"permissions": "Email domains join people with this role, so it cannot have management permissions."})
			}
		}
		_, err := tx.Exec(ctx, `
			UPDATE roles SET name = $3, description = $4, position = $5, permissions = $6, updated_at = now()
			WHERE org_id = $1 AND id = $2`,
			actor.Org.ID, role.ID, role.Name, role.Description, role.Position, permissionStrings(role.Permissions))
		if database.IsUniqueViolation(err, "roles_org_name_key") {
			return httpx.Invalid(map[string]string{"name": "A role with this name already exists."})
		}
		if err != nil {
			return err
		}
		ev := audit.FromRequest(r, "role.updated")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "role", role.ID.String()
		ev.Metadata = map[string]any{
			"name":        map[string]any{"from": before.Name, "to": role.Name},
			"position":    map[string]any{"from": before.Position, "to": role.Position},
			"permissions": map[string]any{"from": before.Permissions, "to": role.Permissions},
		}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"role": role})
	return nil
}

func (s *Service) DeleteRole(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	roleID, err := uuid.Parse(chi.URLParam(r, "roleID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		role, err := loadRole(ctx, tx, actor.Org.ID, roleID)
		if err != nil {
			return err
		}
		switch {
		case role == nil:
			return httpx.ErrNotFound
		case role.IsSystem:
			return errRoleImmutable
		case !actor.Outranks(role.Position):
			return errRoleOutranked
		}
		var members, pending, domains bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM memberships WHERE role_id = $1),
			       EXISTS (SELECT 1 FROM invitations WHERE role_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
			       OR EXISTS (SELECT 1 FROM access_keys WHERE role_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()),
			       EXISTS (SELECT 1 FROM organization_domains WHERE role_id = $1)`,
			role.ID).Scan(&members, &pending, &domains); err != nil {
			return err
		}
		if domains {
			return httpx.NewError(http.StatusConflict, "role_in_use", "Email domains join people with this role. Change or remove them first.")
		}
		if members {
			return httpx.NewError(http.StatusConflict, "role_in_use", "Move members to another role before deleting this one.")
		}
		if pending {
			return httpx.NewError(http.StatusConflict, "role_in_use", "Revoke pending invitations and access keys for this role before deleting it.")
		}
		if _, err := tx.Exec(ctx, `DELETE FROM roles WHERE org_id = $1 AND id = $2`, actor.Org.ID, role.ID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "role.deleted")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "role", role.ID.String()
		ev.Metadata = map[string]any{"name": role.Name}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}
