package org

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/i18n"
)

type Workspace struct {
	Organization Organization `json:"organization"`
	Role         Role         `json:"role"`
}

// Me returns the signed-in user and every workspace they belong to, with the role and
// permissions the client uses to decide what to show.
func (s *Service) Me(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustIdentity(r.Context())
	ms, err := ListMemberships(r.Context(), s.db, id.User.ID)
	if err != nil {
		return err
	}
	workspaces := make([]Workspace, len(ms))
	for i, m := range ms {
		workspaces[i] = Workspace{Organization: m.Org, Role: m.Role}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"user": id.User, "workspaces": workspaces})
	return nil
}

func (s *Service) Permissions(w http.ResponseWriter, r *http.Request) error {
	l := i18n.FromContext(r.Context())
	out := make([]PermissionInfo, len(Catalog))
	for i, p := range Catalog {
		out[i] = PermissionInfo{Key: p.Key, Name: i18n.T(l, p.Name), Description: i18n.T(l, p.Description)}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"permissions": out})
	return nil
}

// CreateOrganizationHandler lets instance administrators create additional workspaces.
func (s *Service) CreateOrganizationHandler(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustIdentity(r.Context())
	if !id.User.IsInstanceAdmin {
		return httpx.ErrForbidden
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	var o Organization
	err := database.InTx(r.Context(), s.db, func(tx pgx.Tx) error {
		var err error
		if o, err = CreateOrganization(r.Context(), tx, in.Name, id.User.ID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "org.created")
		ev.OrgID, ev.ActorID = &o.ID, &id.User.ID
		ev.TargetType, ev.TargetID = "organization", o.ID.String()
		ev.Metadata = map[string]any{"name": o.Name}
		return audit.Record(r.Context(), tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"organization": o})
	return nil
}

func (s *Service) GetOrganization(w http.ResponseWriter, r *http.Request) error {
	m := mustMembership(r.Context())
	httpx.WriteJSON(w, http.StatusOK, Workspace{Organization: m.Org, Role: m.Role})
	return nil
}

func (s *Service) UpdateOrganization(w http.ResponseWriter, r *http.Request) error {
	m := mustMembership(r.Context())
	var in struct {
		Name string `json:"name"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	name, msg := NormalizeName(in.Name)
	if msg != "" {
		return httpx.Invalid(map[string]string{"name": msg})
	}
	o := m.Org
	if name != o.Name {
		err := database.InTx(r.Context(), s.db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(r.Context(), `UPDATE organizations SET name = $2, updated_at = now() WHERE id = $1`, o.ID, name); err != nil {
				return err
			}
			ev := audit.FromRequest(r, "org.updated")
			ev.OrgID, ev.ActorID = &o.ID, &m.UserID
			ev.TargetType, ev.TargetID = "organization", o.ID.String()
			ev.Metadata = map[string]any{"name": map[string]string{"from": o.Name, "to": name}}
			return audit.Record(r.Context(), tx, ev)
		})
		if err != nil {
			return err
		}
		o.Name = name
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"organization": o})
	return nil
}
