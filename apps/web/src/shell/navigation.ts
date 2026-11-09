import type { Workspace } from '@fudislte/api-client'
import {
  AudioLinesIcon,
  FolderKanbanIcon,
  HouseIcon,
  ListChecksIcon,
  type LucideIcon,
  MessageSquareIcon,
  PenToolIcon,
  SettingsIcon,
  VideoIcon,
} from 'lucide-react'

import type { MessageKey } from '../i18n'

export interface NavItem {
  /** Path relative to the workspace root, e.g. "" or "settings". */
  path: string
  label: MessageKey
  icon: LucideIcon
  /** Hide the entry when the member's role cannot use the feature. */
  visible?: (ws: Workspace) => boolean
}

/**
 * Primary navigation, in the order of the design. Each module adds its entry when it
 * ships, so the menu never shows features that do not exist.
 */
export const primaryNav: NavItem[] = [
  { path: '', label: 'nav.home', icon: HouseIcon },
  { path: 'messages', label: 'nav.messages', icon: MessageSquareIcon },
  { path: 'rooms', label: 'nav.rooms', icon: AudioLinesIcon },
  // Everyone may be invited to meetings, guests included.
  { path: 'meetings', label: 'nav.meetings', icon: VideoIcon },
  // Guests take part in the projects (and their boards) they are added to.
  { path: 'tasks', label: 'nav.tasks', icon: ListChecksIcon },
  { path: 'projects', label: 'nav.projects', icon: FolderKanbanIcon },
  { path: 'boards', label: 'nav.boards', icon: PenToolIcon },
  { path: 'settings', label: 'nav.settings', icon: SettingsIcon },
]
