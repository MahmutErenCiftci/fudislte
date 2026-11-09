import type { BadgeVariant } from '@fudislte/ui'
import {
  CodeIcon,
  CrownIcon,
  LightbulbIcon,
  type LucideIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SquareKanbanIcon,
  TagIcon,
  UserIcon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react'

interface RoleStyle {
  tone: BadgeVariant
  icon: LucideIcon
}

const styles: Record<string, RoleStyle> = {
  owner: { tone: 'amber', icon: CrownIcon },
  administrator: { tone: 'primary', icon: ShieldIcon },
  'security-administrator': { tone: 'slate', icon: ShieldCheckIcon },
  'team-leader': { tone: 'violet', icon: UsersIcon },
  'project-manager': { tone: 'emerald', icon: SquareKanbanIcon },
  'product-manager': { tone: 'sky', icon: LightbulbIcon },
  developer: { tone: 'primary', icon: CodeIcon },
  employee: { tone: 'slate', icon: UserIcon },
  guest: { tone: 'pink', icon: UserRoundIcon },
}

/** Badge color and icon for a role; custom roles share one neutral style. */
export function roleStyle(key: string): RoleStyle {
  return styles[key] ?? { tone: 'sky', icon: TagIcon }
}
