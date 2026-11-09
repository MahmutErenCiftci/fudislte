import type { Member, RoleRef } from '@fudislte/api-client'

export interface MemberGroup {
  role: RoleRef
  members: Member[]
}

/**
 * Groups members by role for the member sidebar: highest-ranked role first, members
 * sorted by name within a group.
 */
export function groupMembersByRole(members: Member[]): MemberGroup[] {
  const groups = new Map<string, MemberGroup>()
  for (const m of members) {
    let g = groups.get(m.role.id)
    if (!g) {
      g = { role: m.role, members: [] }
      groups.set(m.role.id, g)
    }
    g.members.push(m)
  }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
  return [...groups.values()]
    .sort((a, b) => b.role.position - a.role.position || collator.compare(a.role.name, b.role.name))
    .map((g) => ({ ...g, members: g.members.sort((a, b) => collator.compare(a.user.displayName, b.user.displayName)) }))
}
