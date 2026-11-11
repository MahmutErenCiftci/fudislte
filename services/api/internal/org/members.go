package org

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

type MemberUser struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
	Email       string    `json:"email"`
}

// RoleRef is the part of a role clients need to label and group members.
type RoleRef struct {
	ID       uuid.UUID `json:"id"`
	Key      string    `json:"key"`
	Name     string    `json:"name"`
	Position int       `json:"position"`
}

type Member struct {
	User     MemberUser `json:"user"`
	Role     RoleRef    `json:"role"`
	JoinedAt time.Time  `json:"joinedAt"`
	// LastActiveAt is the newest session activity. Only members who can manage members
	// receive it; everyone else sees the field omitted.
	LastActiveAt *time.Time `json:"lastActiveAt,omitempty"`
	// Disabled accounts cannot sign in anywhere on the server.
	Disabled bool `json:"disabled"`
}

var (
	errLastOwner = httpx.NewError(http.StatusConflict, "last_owner", "A workspace needs at least one owner.")
	errOutranked = httpx.NewError(http.StatusForbidden, "forbidden", "You can only manage members whose role ranks below yours.")
	errAssign    = httpx.NewError(http.StatusForbidden, "forbidden", "You can only assign roles that rank below yours.")
)

const memberQuery = `
	SELECT u.id, u.display_name, u.email, r.id, r.key, r.name, r.position, m.joined_at, u.disabled_at IS NOT NULL
	FROM memberships m
	JOIN users u ON u.id = m.user_id
	JOIN roles r ON r.id = m.role_id
	WHERE m.org_id = $1`

func scanMember(row pgx.Row) (Member, error) {
	var m Member
	err := row.Scan(&m.User.ID, &m.User.DisplayName, &m.User.Email, &m.Role.ID, &m.Role.Key, &m.Role.Name, &m.Role.Position, &m.JoinedAt, &m.Disabled)
	return m, err
}

func loadMember(ctx context.Context, q database.Querier, orgID, userID uuid.UUID) (*Member, error) {
	m, err := scanMember(q.QueryRow(ctx, memberQuery+` AND m.user_id = $2`, orgID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// ListMembers returns members ordered by role rank, then name — the order of the
// member sidebar.
func (s *Service) ListMembers(w http.ResponseWriter, r *http.Request) error {
	m := mustMembership(r.Context())
	showActivity := m.Can(PermMembersManage)
	rows, err := s.db.Query(r.Context(), `
		SELECT u.id, u.display_name, u.email, r.id, r.key, r.name, r.position, m.joined_at, u.disabled_at IS NOT NULL,
		       (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL)
		FROM memberships m
		JOIN users u ON u.id = m.user_id
		JOIN roles r ON r.id = m.role_id
		WHERE m.org_id = $1
		ORDER BY r.position DESC, r.name, lower(u.display_name), u.id`, m.Org.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	members := []Member{}
	for rows.Next() {
		var mem Member
		var lastActive *time.Time
		if err := rows.Scan(&mem.User.ID, &mem.User.DisplayName, &mem.User.Email, &mem.Role.ID, &mem.Role.Key,
			&mem.Role.Name, &mem.Role.Position, &mem.JoinedAt, &mem.Disabled, &lastActive); err != nil {
			return err
		}
		if showActivity {
			mem.LastActiveAt = lastActive
		}
		members = append(members, mem)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"members": members})
	return nil
}

func (s *Service) UpdateMember(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	targetID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	var in struct {
		RoleID uuid.UUID `json:"roleId"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}

	var updated *Member
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		owners, err := lockOwners(ctx, tx, actor.Org.ID)
		if err != nil {
			return err
		}
		target, err := LoadMembership(ctx, tx, actor.Org.ID, targetID)
		if err != nil {
			return err
		}
		if target == nil {
			return httpx.ErrNotFound
		}
		role, err := loadRole(ctx, tx, actor.Org.ID, in.RoleID)
		if err != nil {
			return err
		}
		if role == nil {
			return httpx.Invalid(map[string]string{"roleId": "Choose a role from this workspace."})
		}
		if role.ID != target.Role.ID {
			switch {
			case !actor.Outranks(target.Role.Position):
				return errOutranked
			case !actor.CanAssign(*role):
				return errAssign
			case target.IsOwner() && !role.isOwner() && owners <= 1:
				return errLastOwner
			}
			if _, err := tx.Exec(ctx, `UPDATE memberships SET role_id = $3 WHERE org_id = $1 AND user_id = $2`,
				actor.Org.ID, targetID, role.ID); err != nil {
				return err
			}
			// A role without rooms.join ends every room admission at once, including the
			// rooms the person created (the chat cleanup job also catches edited roles).
			if !slices.Contains(role.Permissions, PermRoomsJoin) {
				if _, err := tx.Exec(ctx, `
					DELETE FROM channel_members cm USING channels c
					WHERE c.id = cm.channel_id AND c.kind = 'room' AND cm.org_id = $1 AND cm.user_id = $2`,
					actor.Org.ID, targetID); err != nil {
					return err
				}
			}
			ev := audit.FromRequest(r, "member.role_changed")
			ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
			ev.TargetType, ev.TargetID = "user", targetID.String()
			ev.Metadata = map[string]any{"fromRole": target.Role.Name, "toRole": role.Name}
			if err := audit.Record(ctx, tx, ev); err != nil {
				return err
			}
		}
		updated, err = loadMember(ctx, tx, actor.Org.ID, targetID)
		return err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"member": updated})
	return nil
}

func (s *Service) RemoveMember(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	targetID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	if targetID == actor.UserID {
		return httpx.NewError(http.StatusConflict, "cannot_remove_self", "You cannot remove yourself from the workspace.")
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		owners, err := lockOwners(ctx, tx, actor.Org.ID)
		if err != nil {
			return err
		}
		target, err := loadMember(ctx, tx, actor.Org.ID, targetID)
		if err != nil {
			return err
		}
		if target == nil {
			return httpx.ErrNotFound
		}
		if !actor.Outranks(target.Role.Position) {
			return errOutranked
		}
		if target.Role.Key == OwnerRoleKey && owners <= 1 {
			return errLastOwner
		}
		if _, err := tx.Exec(ctx, `DELETE FROM memberships WHERE org_id = $1 AND user_id = $2`, actor.Org.ID, targetID); err != nil {
			return err
		}
		// A room's creator enters without its password; someone who leaves the workspace
		// must not get that back by being invited again.
		if _, err := tx.Exec(ctx, `UPDATE channels SET created_by = NULL WHERE org_id = $1 AND kind = 'room' AND created_by = $2`, actor.Org.ID, targetID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "member.removed")
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "user", targetID.String()
		ev.Metadata = map[string]any{"displayName": target.User.DisplayName, "email": target.User.Email, "role": target.Role.Name}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

var (
	errDisableSelf       = httpx.NewError(http.StatusConflict, "disable_self", "You cannot disable your own account.")
	errLastInstanceAdmin = httpx.NewError(http.StatusConflict, "last_instance_admin", "The server needs at least one active administrator.")
)

func (s *Service) DisableMember(w http.ResponseWriter, r *http.Request) error {
	return s.setDisabled(w, r, true)
}
func (s *Service) EnableMember(w http.ResponseWriter, r *http.Request) error {
	return s.setDisabled(w, r, false)
}

// setDisabled disables or re-enables a member's account. Only instance administrators
// may: an account spans every workspace on the server. A disabled account cannot request
// codes or sign in, and its sessions and live streams end at once; its memberships and
// messages stay.
func (s *Service) setDisabled(w http.ResponseWriter, r *http.Request, disable bool) error {
	ctx := r.Context()
	actor := mustMembership(ctx)
	if !auth.MustIdentity(ctx).User.IsInstanceAdmin {
		return httpx.ErrForbidden
	}
	targetID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		return httpx.ErrNotFound
	}
	if disable && targetID == actor.UserID {
		return errDisableSelf
	}
	var revoked []uuid.UUID
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		target, err := loadMember(ctx, tx, actor.Org.ID, targetID)
		if err != nil {
			return err
		}
		if target == nil {
			return httpx.ErrNotFound
		}
		if target.Disabled == disable {
			return nil
		}
		if disable {
			var otherAdmins int
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM users WHERE is_instance_admin AND disabled_at IS NULL AND id <> $1`, targetID).Scan(&otherAdmins); err != nil {
				return err
			}
			var targetAdmin bool
			if err := tx.QueryRow(ctx, `SELECT is_instance_admin FROM users WHERE id = $1`, targetID).Scan(&targetAdmin); err != nil {
				return err
			}
			if targetAdmin && otherAdmins == 0 {
				return errLastInstanceAdmin
			}
			if _, err := tx.Exec(ctx, `UPDATE users SET disabled_at = now() WHERE id = $1`, targetID); err != nil {
				return err
			}
			if revoked, err = auth.RevokeUserSessions(ctx, tx, targetID); err != nil {
				return err
			}
		} else if _, err := tx.Exec(ctx, `UPDATE users SET disabled_at = NULL WHERE id = $1`, targetID); err != nil {
			return err
		}
		action := "member.enabled"
		if disable {
			action = "member.disabled"
		}
		ev := audit.FromRequest(r, action)
		ev.OrgID, ev.ActorID = &actor.Org.ID, &actor.UserID
		ev.TargetType, ev.TargetID = "user", targetID.String()
		ev.Metadata = map[string]any{"displayName": target.User.DisplayName, "email": target.User.Email}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.auth.CloseSessions(revoked...)
	member, err := loadMember(ctx, s.db, actor.Org.ID, targetID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"member": member})
	return nil
}
