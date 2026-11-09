import type { Permission, User, Workspace } from '@fudislte/api-client'
import {
  AudioLinesIcon,
  FileClockIcon,
  GlobeLockIcon,
  KeyRoundIcon,
  type LucideIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react'

import type { MessageKey } from '../../i18n'
import { can } from '../../lib/permissions'

export interface SettingsSection {
  path: string
  label: MessageKey
  description: MessageKey
  icon: LucideIcon
  visible?: (ws: Workspace, user: User) => boolean
}

const anyOf = (...perms: Permission[]) => (ws: Workspace) => perms.some((p) => can(ws, p))

/** Settings tabs, in display order. Used by the tab bar and the command palette. */
export const settingsSections: SettingsSection[] = [
  { path: 'account', label: 'settings.account', description: 'settings.accountDescription', icon: UserIcon },
  {
    path: 'general',
    label: 'settings.general',
    description: 'settings.generalDescription',
    icon: SettingsIcon,
    visible: anyOf('org.manage'),
  },
  {
    path: 'users',
    label: 'settings.users',
    description: 'settings.usersDescription',
    icon: UsersIcon,
    visible: anyOf('members.view', 'members.invite', 'members.manage'),
  },
  {
    path: 'roles',
    label: 'settings.roles',
    description: 'settings.rolesDescription',
    icon: ShieldCheckIcon,
    visible: anyOf('roles.manage'),
  },
  {
    path: 'access',
    label: 'settings.access',
    description: 'settings.accessDescription',
    icon: GlobeLockIcon,
    visible: anyOf('org.manage'),
  },
  {
    path: 'security',
    label: 'settings.security',
    description: 'settings.securityDescription',
    icon: KeyRoundIcon,
    // Access keys need members.invite; the session lifetime is for instance administrators.
    visible: (ws, user) => can(ws, 'members.invite') || user.isInstanceAdmin,
  },
  {
    path: 'rooms',
    label: 'settings.rooms',
    description: 'settings.roomsDescription',
    icon: AudioLinesIcon,
    visible: anyOf('rooms.manage'),
  },
  {
    path: 'audit',
    label: 'settings.audit',
    description: 'settings.auditDescription',
    icon: FileClockIcon,
    visible: anyOf('audit.view'),
  },
]

export function visibleSettingsSections(ws: Workspace, user: User): SettingsSection[] {
  return settingsSections.filter((s) => s.visible?.(ws, user) ?? true)
}
