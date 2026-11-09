package org

import "slices"

// Permission is a capability granted to a role inside one organization. The catalog is
// defined in code so every check is typed; later modules append their own permissions.
type Permission string

const (
	PermOrgManage     Permission = "org.manage"
	PermMembersView   Permission = "members.view"
	PermMembersInvite Permission = "members.invite"
	PermMembersManage Permission = "members.manage"
	PermRolesManage   Permission = "roles.manage"
	PermAuditView     Permission = "audit.view"

	PermChannelsJoin   Permission = "channels.join"
	PermChannelsCreate Permission = "channels.create"
	PermChannelsManage Permission = "channels.manage"
	PermMessagesManage Permission = "messages.manage"

	PermRoomsJoin   Permission = "rooms.join"
	PermRoomsCreate Permission = "rooms.create"
	PermRoomsManage Permission = "rooms.manage"

	PermMeetingsCreate Permission = "meetings.create"

	PermProjectsView   Permission = "projects.view"
	PermProjectsCreate Permission = "projects.create"
	PermProjectsManage Permission = "projects.manage"
	PermBoardsCreate   Permission = "boards.create"
)

type PermissionInfo struct {
	Key         Permission `json:"key"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
}

var Catalog = []PermissionInfo{
	{PermOrgManage, "Manage workspace", "Edit the workspace name and settings."},
	{PermMembersView, "View members", "See the member directory, including email addresses."},
	{PermMembersInvite, "Invite members", "Create and revoke invitation links."},
	{PermMembersManage, "Manage members", "Change member roles and remove members."},
	{PermRolesManage, "Manage roles", "Create, edit and delete roles."},
	{PermAuditView, "View audit log", "Read the workspace audit log."},
	{PermChannelsJoin, "Join public channels", "See the workspace's public channels and join them."},
	{PermChannelsCreate, "Create channels", "Create public and private channels."},
	{PermChannelsManage, "Manage channels", "Rename channels and remove channel members."},
	{PermMessagesManage, "Moderate messages", "Delete other members' messages."},
	{PermRoomsJoin, "Enter rooms", "See open and password-protected rooms and enter them (with the password)."},
	{PermRoomsCreate, "Create rooms", "Create open, password-protected and restricted rooms."},
	{PermRoomsManage, "Manage room security", "Change any room's access and password, end admissions and delete rooms. Does not admit them to a room."},
	{PermMeetingsCreate, "Create meetings", "Schedule voice and video meetings and invite people to them."},
	{PermProjectsView, "View public projects", "See the workspace's public projects and their tasks, and join them."},
	{PermProjectsCreate, "Create projects", "Create public and private projects; the creator leads them."},
	{PermProjectsManage, "Manage projects", "Manage every project the member can see: settings, workflow, labels, members, sprints and archiving. Private projects stay visible to their members only."},
	{PermBoardsCreate, "Use workspace whiteboards", "Create whiteboards and open and edit the workspace's shared whiteboards. Project whiteboards follow project access."},
}

func IsKnownPermission(p Permission) bool {
	return slices.ContainsFunc(Catalog, func(info PermissionInfo) bool { return info.Key == p })
}

func allPermissions() []Permission {
	out := make([]Permission, len(Catalog))
	for i, info := range Catalog {
		out[i] = info.Key
	}
	return out
}

const (
	OwnerRoleKey = "owner"
	// OwnerPosition is reserved for the Owner role; other roles rank strictly below it.
	OwnerPosition   = 100
	MaxRolePosition = OwnerPosition - 1
)

type roleTemplate struct {
	Key         string
	Name        string
	Description string
	Position    int
	Permissions []Permission
	System      bool
}

// defaultRoles are created for every new organization. Only Owner is immutable; the
// others are sensible defaults that administrators may adjust.
var defaultRoles = []roleTemplate{
	{OwnerRoleKey, "Owner", "Full control of the workspace.", OwnerPosition, allPermissions(), true},
	{"administrator", "Administrator", "Manages members, roles and workspace settings.", 90, allPermissions(), false},
	{"security-administrator", "Security Administrator", "Reviews security events and the member directory.", 80,
		memberPermissions(PermAuditView, PermRoomsManage), false},
	{"team-leader", "Team Leader", "Leads a team and invites new members.", 60, memberPermissions(PermMembersInvite), false},
	{"project-manager", "Project Manager", "Coordinates projects and invites collaborators.", 50, memberPermissions(PermMembersInvite), false},
	{"product-manager", "Product Manager", "Owns product direction and priorities.", 50, memberPermissions(), false},
	{"developer", "Developer", "Builds and maintains software.", 30, memberPermissions(), false},
	{"employee", "Employee", "Standard member of the workspace.", 20, memberPermissions(), false},
	{"guest", "Guest", "Limited access to explicitly shared spaces.", 10, nil, false},
}

// memberPermissions is what every default role but Guest holds, plus extra.
func memberPermissions(extra ...Permission) []Permission {
	return append([]Permission{
		PermMembersView, PermChannelsJoin, PermChannelsCreate, PermRoomsJoin, PermRoomsCreate, PermMeetingsCreate,
		PermProjectsView, PermProjectsCreate, PermBoardsCreate,
	}, extra...)
}
