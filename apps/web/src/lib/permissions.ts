import type { Permission, Role, RoleRef, Workspace } from '@fudislte/api-client'

// Client-side mirrors of the API's authorization rules. They only decide what to show;
// the API enforces every rule independently.

export const OWNER_ROLE_KEY = 'owner'

/** Permissions the API never hands out automatically through an email domain. */
export const MANAGEMENT_PERMISSIONS: Permission[] = [
  'org.manage',
  'members.manage',
  'roles.manage',
  'channels.manage',
  'messages.manage',
  'rooms.manage',
  'projects.manage',
]

export function isOwner(role: Pick<Role, 'key'>): boolean {
  return role.key === OWNER_ROLE_KEY
}

export function can(ws: Workspace | undefined, permission: Permission): boolean {
  return !!ws && ws.role.permissions.includes(permission)
}

/** Whether `actor` has authority over something ranked at `position`. */
export function outranks(actor: Pick<Role, 'key' | 'position'>, position: number): boolean {
  return isOwner(actor) || actor.position > position
}

export function canAssign(actor: Pick<Role, 'key' | 'position'>, role: Pick<RoleRef, 'key' | 'position'>): boolean {
  if (isOwner(role)) return isOwner(actor)
  return isOwner(actor) || role.position < actor.position
}
