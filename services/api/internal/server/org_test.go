package server_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestInvitationFlow(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	roles := owner.roles(orgID)
	token := owner.invite(orgID, "Dev@Example.com", roles["developer"].ID)

	// The invitation is emailed with a link to the public URL.
	invitation := ts.mail.Next(t, "dev@example.com", "invitation")
	if !strings.Contains(invitation.Body, publicURL+"/invite/"+token) {
		t.Fatalf("invitation email lacks the link: %q", invitation.Body)
	}

	anon := ts.client()
	var preview struct {
		Invitation struct {
			Email            string `json:"email"`
			OrganizationName string `json:"organizationName"`
			RoleName         string `json:"roleName"`
			AccountExists    bool   `json:"accountExists"`
		} `json:"invitation"`
	}
	anon.must(http.StatusOK, http.MethodGet, "/api/v1/invitations/"+token, nil).decode(t, &preview)
	if p := preview.Invitation; p.Email != "dev@example.com" || p.OrganizationName != "Acme Şirketi" || p.RoleName != "Developer" || p.AccountExists {
		t.Fatalf("preview = %+v", p)
	}

	// Holding the link is not enough: the person must prove they own the address.
	expectError(t, anon.do(http.MethodPost, "/api/v1/invitations/"+token+"/accept",
		map[string]string{"displayName": "Dana", "code": "12345678"}), http.StatusUnauthorized, "invalid_code")
	code := ts.invitationCode(anon, token, "dev@example.com")
	expectError(t, anon.do(http.MethodPost, "/api/v1/invitations/"+token+"/accept",
		map[string]string{"displayName": " ", "code": code}), http.StatusUnprocessableEntity, "validation_failed")
	anon.must(http.StatusOK, http.MethodPost, "/api/v1/invitations/"+token+"/accept",
		map[string]string{"displayName": "Dana Developer", "code": code})

	m := anon.me()
	if len(m.Workspaces) != 1 || m.Workspaces[0].Role.Key != "developer" || m.User.IsInstanceAdmin {
		t.Fatalf("new member = %+v", m)
	}

	// The link is single-use.
	expectError(t, ts.client().do(http.MethodGet, "/api/v1/invitations/"+token, nil), http.StatusNotFound, "invitation_invalid")
	expectError(t, ts.client().do(http.MethodPost, "/api/v1/invitations/"+token+"/code", nil), http.StatusNotFound, "invitation_invalid")

	// Developers can see the directory, ordered by role rank, but not manage it.
	var members struct {
		Members []struct {
			User struct {
				DisplayName string `json:"displayName"`
			} `json:"user"`
			Role struct {
				Key string `json:"key"`
			} `json:"role"`
		} `json:"members"`
	}
	anon.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/members", nil).decode(t, &members)
	if len(members.Members) != 2 || members.Members[0].Role.Key != "owner" || members.Members[1].User.DisplayName != "Dana Developer" {
		t.Fatalf("members = %+v", members)
	}
	expectError(t, anon.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/invitations",
		map[string]string{"email": "x@example.com", "roleId": roles["guest"].ID}), http.StatusForbidden, "forbidden")
	expectError(t, anon.do(http.MethodGet, "/api/v1/orgs/"+orgID+"/audit-events", nil), http.StatusForbidden, "forbidden")

	// Inviting an existing member is rejected.
	expectError(t, owner.do(http.MethodPost, "/api/v1/orgs/"+orgID+"/invitations",
		map[string]string{"email": "dev@example.com", "roleId": roles["guest"].ID}), http.StatusUnprocessableEntity, "validation_failed")

	var events struct {
		Events []struct {
			Action string `json:"action"`
		} `json:"events"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/audit-events", nil).decode(t, &events)
	var actions []string
	for _, e := range events.Events {
		actions = append(actions, e.Action)
	}
	for _, want := range []string{"instance.setup_completed", "invitation.created", "invitation.accepted"} {
		if !slices.Contains(actions, want) {
			t.Errorf("audit log %v is missing %s", actions, want)
		}
	}
}

func TestRevokedInvitationCannotBeUsed(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	roles := owner.roles(orgID)
	token := owner.invite(orgID, "temp@example.com", roles["employee"].ID)

	var list struct {
		Invitations []struct {
			ID string `json:"id"`
		} `json:"invitations"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/invitations", nil).decode(t, &list)
	if len(list.Invitations) != 1 {
		t.Fatalf("invitations = %+v", list)
	}
	owner.must(http.StatusNoContent, http.MethodDelete, "/api/v1/orgs/"+orgID+"/invitations/"+list.Invitations[0].ID, nil)
	expectError(t, ts.client().do(http.MethodPost, "/api/v1/invitations/"+token+"/code", nil), http.StatusNotFound, "invitation_invalid")

	// Re-inviting supersedes the previous link.
	first := owner.invite(orgID, "again@example.com", roles["employee"].ID)
	second := owner.invite(orgID, "again@example.com", roles["guest"].ID)
	expectError(t, ts.client().do(http.MethodGet, "/api/v1/invitations/"+first, nil), http.StatusNotFound, "invitation_invalid")
	ts.client().must(http.StatusOK, http.MethodGet, "/api/v1/invitations/"+second, nil)
}

func TestExistingAccountMustSignInToAcceptInvitation(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	dev, _ := ts.join(owner, orgID, "dev@example.com", "developer")

	var created struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs", map[string]string{"name": "Second Workspace"}).decode(t, &created)
	org2 := created.Organization.ID
	token := owner.invite(org2, "dev@example.com", owner.roles(org2)["employee"].ID)

	expectError(t, ts.client().do(http.MethodPost, "/api/v1/invitations/"+token+"/code", nil), http.StatusConflict, "sign_in_required")
	expectError(t, owner.do(http.MethodPost, "/api/v1/invitations/"+token+"/accept", map[string]string{}),
		http.StatusForbidden, "invitation_email_mismatch")

	dev.must(http.StatusOK, http.MethodPost, "/api/v1/invitations/"+token+"/accept", map[string]string{})
	if n := len(dev.me().Workspaces); n != 2 {
		t.Fatalf("dev belongs to %d workspaces, want 2", n)
	}
}

func TestDomainAutoJoin(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	roles := owner.roles(orgID)
	domains := "/api/v1/orgs/" + orgID + "/domains"

	expectError(t, owner.do(http.MethodPost, domains, map[string]string{"domain": "gmail.com", "roleId": roles["employee"].ID}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPost, domains, map[string]string{"domain": "not a domain", "roleId": roles["employee"].ID}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPost, domains, map[string]string{"domain": "firma.test", "roleId": roles["administrator"].ID}),
		http.StatusUnprocessableEntity, "validation_failed")
	owner.must(http.StatusCreated, http.MethodPost, domains, map[string]string{"domain": "@Firma.TEST", "roleId": roles["employee"].ID})
	expectError(t, owner.do(http.MethodPost, domains, map[string]string{"domain": "firma.test", "roleId": roles["guest"].ID}),
		http.StatusUnprocessableEntity, "validation_failed")

	// Until the TXT record is published, the domain lets nobody in.
	var listed struct {
		Domains []struct {
			Domain     string  `json:"domain"`
			Record     string  `json:"record"`
			VerifiedAt *string `json:"verifiedAt"`
		} `json:"domains"`
	}
	owner.must(http.StatusOK, http.MethodGet, domains, nil).decode(t, &listed)
	record := listed.Domains[0].Record
	if listed.Domains[0].VerifiedAt != nil || !strings.HasPrefix(record, "fudislte-verification=") {
		t.Fatalf("new domain = %+v", listed.Domains[0])
	}
	ts.client().must(http.StatusAccepted, http.MethodPost, "/api/v1/auth/code", map[string]string{"email": "early@firma.test"})
	ts.mail.None(t, "early@firma.test", "login_code", 300*time.Millisecond)
	expectError(t, owner.do(http.MethodPost, domains+"/firma.test/verify", nil), http.StatusUnprocessableEntity, "domain_not_verified")
	ts.dns.set("firma.test", "v=spf1 -all", "fudislte-verification=someone-else")
	expectError(t, owner.do(http.MethodPost, domains+"/firma.test/verify", nil), http.StatusUnprocessableEntity, "domain_not_verified")
	ts.dns.set("_fudislte-verification.firma.test", record)
	owner.must(http.StatusOK, http.MethodPost, domains+"/firma.test/verify", nil).decode(t, &listed)
	if listed.Domains[0].VerifiedAt == nil {
		t.Fatal("domain not verified")
	}

	// Someone at the company domain signs in for the first time and joins as Employee.
	newcomer := ts.client()
	code := ts.requestCode(newcomer, "deniz.kaya@firma.test")
	var out struct {
		NewAccount bool `json:"newAccount"`
		User       struct {
			DisplayName string `json:"displayName"`
		} `json:"user"`
	}
	newcomer.must(http.StatusOK, http.MethodPost, "/api/v1/auth/verify",
		map[string]string{"email": "deniz.kaya@firma.test", "code": code}).decode(t, &out)
	if !out.NewAccount || out.User.DisplayName != "Deniz Kaya" {
		t.Fatalf("verify = %+v", out)
	}
	m := newcomer.me()
	if len(m.Workspaces) != 1 || m.Workspaces[0].Role.Key != "employee" {
		t.Fatalf("newcomer = %+v", m)
	}

	// Other domains get nothing.
	ts.client().must(http.StatusAccepted, http.MethodPost, "/api/v1/auth/code", map[string]string{"email": "eve@other.test"})
	ts.mail.None(t, "eve@other.test", "login_code", 300*time.Millisecond)

	// Roles used by a domain cannot be deleted or gain management permissions.
	rolesPath := "/api/v1/orgs/" + orgID + "/roles/" + roles["employee"].ID
	newcomer.must(http.StatusForbidden, http.MethodGet, domains, nil)
	expectError(t, owner.do(http.MethodPatch, rolesPath, map[string]any{"permissions": []string{"members.view", "members.manage"}}),
		http.StatusUnprocessableEntity, "validation_failed")

	owner.must(http.StatusNoContent, http.MethodDelete, domains+"/firma.test", nil)
	ts.client().must(http.StatusAccepted, http.MethodPost, "/api/v1/auth/code", map[string]string{"email": "later@firma.test"})
	ts.mail.None(t, "later@firma.test", "login_code", 300*time.Millisecond)

	// Existing members keep signing in normally.
	again := ts.client()
	again.must(http.StatusOK, http.MethodPost, "/api/v1/auth/verify", map[string]string{
		"email": "deniz.kaya@firma.test", "code": ts.requestCode(again, "deniz.kaya@firma.test"),
	})
}

func TestOrganizationIsolation(t *testing.T) {
	ts := newServer(t)
	owner, org1 := ts.setupInstance()
	dev, devID := ts.join(owner, org1, "dev@example.com", "developer")

	expectError(t, dev.do(http.MethodPost, "/api/v1/orgs", map[string]string{"name": "Shadow IT"}), http.StatusForbidden, "forbidden")

	var created struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs", map[string]string{"name": "Finance"}).decode(t, &created)
	org2 := created.Organization.ID

	// A non-member cannot tell the organization exists.
	for _, path := range []string{"", "/members", "/roles", "/audit-events", "/domains"} {
		expectError(t, dev.do(http.MethodGet, "/api/v1/orgs/"+org2+path, nil), http.StatusNotFound, "not_found")
	}
	expectError(t, dev.do(http.MethodGet, "/api/v1/orgs/not-a-uuid/members", nil), http.StatusNotFound, "not_found")

	// Roles of another organization cannot be assigned, even by an owner.
	foreignRole := owner.roles(org2)["employee"].ID
	expectError(t, owner.do(http.MethodPatch, "/api/v1/orgs/"+org1+"/members/"+devID,
		map[string]string{"roleId": foreignRole}), http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPost, "/api/v1/orgs/"+org1+"/invitations",
		map[string]string{"email": "x@example.com", "roleId": foreignRole}), http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPost, "/api/v1/orgs/"+org1+"/domains",
		map[string]string{"domain": "firma.test", "roleId": foreignRole}), http.StatusUnprocessableEntity, "validation_failed")

	// Managing a user through an organization they do not belong to fails.
	expectError(t, owner.do(http.MethodDelete, "/api/v1/orgs/"+org2+"/members/"+devID, nil), http.StatusNotFound, "not_found")
}

func TestRoleHierarchy(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	roles := owner.roles(orgID)
	ownerID := owner.me().User.ID
	admin, adminID := ts.join(owner, orgID, "admin@example.com", "administrator")
	_, devID := ts.join(owner, orgID, "dev@example.com", "developer")
	members := "/api/v1/orgs/" + orgID + "/members/"

	expectError(t, admin.do(http.MethodPatch, members+ownerID, map[string]string{"roleId": roles["employee"].ID}), http.StatusForbidden, "forbidden")
	expectError(t, admin.do(http.MethodDelete, members+ownerID, nil), http.StatusForbidden, "forbidden")
	expectError(t, admin.do(http.MethodPatch, members+devID, map[string]string{"roleId": roles["owner"].ID}), http.StatusForbidden, "forbidden")
	expectError(t, admin.do(http.MethodPatch, members+devID, map[string]string{"roleId": roles["administrator"].ID}), http.StatusForbidden, "forbidden")
	expectError(t, admin.do(http.MethodPatch, members+adminID, map[string]string{"roleId": roles["owner"].ID}), http.StatusForbidden, "forbidden")
	admin.must(http.StatusOK, http.MethodPatch, members+devID, map[string]string{"roleId": roles["employee"].ID})

	// The last owner can neither be demoted nor remove themselves.
	expectError(t, owner.do(http.MethodPatch, members+ownerID, map[string]string{"roleId": roles["administrator"].ID}), http.StatusConflict, "last_owner")
	expectError(t, owner.do(http.MethodDelete, members+ownerID, nil), http.StatusConflict, "cannot_remove_self")

	// With a second owner, the first may step down.
	owner.must(http.StatusOK, http.MethodPatch, members+adminID, map[string]string{"roleId": roles["owner"].ID})
	owner.must(http.StatusOK, http.MethodPatch, members+ownerID, map[string]string{"roleId": roles["administrator"].ID})
	admin.must(http.StatusNoContent, http.MethodDelete, members+devID, nil)
}

func TestCustomRoles(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	rolesPath := "/api/v1/orgs/" + orgID + "/roles"

	var created struct {
		Role role `json:"role"`
	}
	owner.must(http.StatusCreated, http.MethodPost, rolesPath, map[string]any{
		"name": "Role Manager", "position": 70, "permissions": []string{"roles.manage", "members.view", "members.view"},
	}).decode(t, &created)
	if created.Role.Position != 70 || len(created.Role.Permissions) != 2 {
		t.Fatalf("created role = %+v", created.Role)
	}
	expectError(t, owner.do(http.MethodPost, rolesPath, map[string]any{"name": "Role Manager", "position": 10}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPost, rolesPath, map[string]any{"name": "Root", "position": 100}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPost, rolesPath, map[string]any{"name": "Bad", "position": 5, "permissions": []string{"everything"}}),
		http.StatusUnprocessableEntity, "validation_failed")

	manager, _ := ts.join(owner, orgID, "rm@example.com", created.Role.Key)

	// A role manager can only create roles below their rank with permissions they hold.
	expectError(t, manager.do(http.MethodPost, rolesPath, map[string]any{"name": "Peer", "position": 70}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, manager.do(http.MethodPost, rolesPath, map[string]any{"name": "Auditor", "position": 40, "permissions": []string{"audit.view"}}),
		http.StatusForbidden, "forbidden")
	manager.must(http.StatusCreated, http.MethodPost, rolesPath, map[string]any{"name": "Viewer", "position": 40, "permissions": []string{"members.view"}})
	// ...and cannot edit their own role to escalate.
	expectError(t, manager.do(http.MethodPatch, rolesPath+"/"+created.Role.ID, map[string]any{"permissions": []string{"roles.manage", "audit.view"}}),
		http.StatusForbidden, "forbidden")

	roles := owner.roles(orgID)
	expectError(t, owner.do(http.MethodPatch, rolesPath+"/"+roles["owner"].ID, map[string]any{"name": "King"}), http.StatusConflict, "role_immutable")
	expectError(t, owner.do(http.MethodDelete, rolesPath+"/"+roles["owner"].ID, nil), http.StatusConflict, "role_immutable")
	expectError(t, owner.do(http.MethodDelete, rolesPath+"/"+created.Role.ID, nil), http.StatusConflict, "role_in_use")

	var viewerID string
	for _, r := range roles {
		if r.Name == "Viewer" {
			viewerID = r.ID
		}
	}
	owner.must(http.StatusOK, http.MethodPatch, rolesPath+"/"+viewerID, map[string]any{"name": "Directory Viewer"})
	owner.must(http.StatusNoContent, http.MethodDelete, rolesPath+"/"+viewerID, nil)
}

func TestUpdateOrganizationRequiresPermission(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	dev, _ := ts.join(owner, orgID, "dev@example.com", "developer")
	expectError(t, dev.do(http.MethodPatch, "/api/v1/orgs/"+orgID, map[string]string{"name": "Hacked"}), http.StatusForbidden, "forbidden")
	owner.must(http.StatusOK, http.MethodPatch, "/api/v1/orgs/"+orgID, map[string]string{"name": "Acme Labs"})
	if got := dev.me().Workspaces[0].Organization.Name; got != "Acme Labs" {
		t.Fatalf("name = %q", got)
	}
}

func TestDisableAccount(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	ownerID := owner.me().User.ID
	admin, _ := ts.join(owner, orgID, "admin@example.com", "administrator")
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	members := "/api/v1/orgs/" + orgID + "/members/"

	// Only instance administrators disable accounts; never their own.
	expectError(t, admin.do(http.MethodPost, members+empID+"/disable", nil), http.StatusForbidden, "forbidden")
	expectError(t, owner.do(http.MethodPost, members+ownerID+"/disable", nil), http.StatusConflict, "disable_self")

	// Disabling ends sessions and live streams at once and blocks new codes.
	stream := emp.events()
	var out struct {
		Member struct {
			Disabled bool `json:"disabled"`
		} `json:"member"`
	}
	owner.must(http.StatusOK, http.MethodPost, members+empID+"/disable", nil).decode(t, &out)
	if !out.Member.Disabled {
		t.Fatal("member not marked disabled")
	}
	stream.closed()
	expectError(t, emp.do(http.MethodGet, "/api/v1/me", nil), http.StatusUnauthorized, "unauthorized")
	ts.client().must(http.StatusAccepted, http.MethodPost, "/api/v1/auth/code", map[string]string{"email": "emp@example.com"})
	ts.mail.None(t, "emp@example.com", "login_code", 300*time.Millisecond)

	// Re-enabled, the person signs in again with a new code.
	owner.must(http.StatusOK, http.MethodPost, members+empID+"/enable", nil)
	back := ts.signIn("emp@example.com")
	if back.me().User.ID != empID {
		t.Fatal("re-enabled account cannot sign in")
	}

	var audit struct {
		Events []struct {
			Action string `json:"action"`
		} `json:"events"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/audit-events", nil).decode(t, &audit)
	actions := map[string]bool{}
	for _, e := range audit.Events {
		actions[e.Action] = true
	}
	if !actions["member.disabled"] || !actions["member.enabled"] {
		t.Fatalf("audit log lacks disable events: %v", actions)
	}
}

// A lower rank is not enough to assign a role: it must not grant permissions the person
// assigning it lacks, or a team leader could invite a second account of their own into a
// custom role that moderates messages.
func TestAssignableRolesGrantNothingNew(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	roles := owner.roles(orgID)
	var moderator struct {
		Role struct {
			ID string `json:"id"`
		} `json:"role"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/roles",
		map[string]any{"name": "Moderator", "position": 40, "permissions": []string{"messages.manage"}}).decode(t, &moderator)
	lead, _ := ts.join(owner, orgID, "lead@example.com", "team-leader")
	invitations := "/api/v1/orgs/" + orgID + "/invitations"
	expectError(t, lead.do(http.MethodPost, invitations, map[string]string{"email": "alt@example.com", "roleId": moderator.Role.ID}),
		http.StatusForbidden, "forbidden")
	// Roles that grant nothing new still work.
	lead.must(http.StatusCreated, http.MethodPost, invitations, map[string]string{"email": "new@example.com", "roleId": roles["employee"].ID})
	// Administrators hold every permission and may assign the custom role.
	owner.must(http.StatusCreated, http.MethodPost, invitations, map[string]string{"email": "mod@example.com", "roleId": moderator.Role.ID})
}
