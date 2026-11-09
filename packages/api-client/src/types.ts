// API contract types. They mirror the JSON produced by services/api; keep both sides
// in sync when changing an endpoint.

export type Permission =
  | 'org.manage'
  | 'members.view'
  | 'members.invite'
  | 'members.manage'
  | 'roles.manage'
  | 'audit.view'
  | 'channels.join'
  | 'channels.create'
  | 'channels.manage'
  | 'messages.manage'
  | 'rooms.join'
  | 'rooms.create'
  | 'rooms.manage'
  | 'meetings.create'
  | 'projects.view'
  | 'projects.create'
  | 'projects.manage'
  | 'boards.create'

export interface Meta {
  product: 'fudislte'
  version: string
  setupRequired: boolean
  /** Whether setup offers to register the server with the FUDISLTE project. */
  registrationAvailable: boolean
}

/**
 * Opt-in registration with the FUDISLTE project. A daily report carries exactly
 * organizationName, contactEmail, userCount and version (plus a random server ID).
 */
export interface RegistrationSettings {
  /** False when the server knows no registry; then the option is not offered. */
  available: boolean
  enabled: boolean
  organizationName: string
  contactEmail: string
  /** Active accounts now, as the next report would send it. */
  userCount: number
  version: string
  lastSentAt: string | null
  lastError: string
}

export interface User {
  id: string
  email: string
  displayName: string
  /** Preferred language ("tr", "en"); used for the UI and for emails. */
  locale: string
  isInstanceAdmin: boolean
  createdAt: string
  /** The person's own status, with its private `mute` flag. */
  status?: UserStatus
}

export interface ProfileInput {
  displayName?: string
  locale?: string
}

export interface Organization {
  id: string
  name: string
  slug: string
  createdAt: string
}

export interface Role {
  id: string
  key: string
  name: string
  description: string
  position: number
  permissions: Permission[]
  isSystem: boolean
}

export interface RoleSummary extends Role {
  memberCount: number
}

export interface RoleRef {
  id: string
  key: string
  name: string
  position: number
}

export interface Workspace {
  organization: Organization
  role: Role
}

export interface Me {
  user: User
  workspaces: Workspace[]
}

export interface Member {
  user: { id: string; displayName: string; email: string }
  role: RoleRef
  joinedAt: string
  /** Last session activity; only returned to members who can manage members. */
  lastActiveAt?: string | null
  /** Disabled accounts cannot sign in anywhere on the server. */
  disabled: boolean
}

export interface Invitation {
  id: string
  email: string
  role: RoleRef
  invitedBy: string
  createdAt: string
  expiresAt: string
}

/** A prepared account; the person signs in once with its key, without an email code. */
export interface AccessKey {
  id: string
  email: string
  displayName: string
  /** Language of the account it creates ("tr", "en"). */
  locale: string
  role: RoleRef
  createdBy: string
  createdAt: string
  expiresAt: string
}

export interface AccessKeyInput {
  email: string
  displayName: string
  roleId: string
  locale?: string
  /** 1–90; 7 when omitted. */
  validDays?: number
}

/** Server-wide: everyone signs in again after this many hours (48 by default). */
export interface SessionPolicy {
  ttlHours: number
  updatedAt: string
}

export interface InvitationPreview {
  email: string
  organizationName: string
  roleName: string
  expiresAt: string
  accountExists: boolean
}

export interface SessionInfo {
  id: string
  userAgent: string
  ipAddress: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  current: boolean
}

export interface PermissionInfo {
  key: Permission
  name: string
  description: string
}

export interface AuditEvent {
  id: number
  action: string
  actor: { id: string; displayName: string; email: string } | null
  targetType: string
  targetId: string
  metadata: Record<string, unknown>
  ipAddress: string
  userAgent: string
  createdAt: string
}

export interface SetupInput {
  setupToken: string
  organizationName: string
  displayName: string
  email: string
  /** One-time code emailed by `setupCode`. */
  code: string
  /** The owner's consent to register the server (workspace name, their email, users, version). */
  shareRegistration?: boolean
}

/** An email domain whose people join the workspace automatically on first sign-in. */
export interface Domain {
  domain: string
  role: RoleRef
  createdAt: string
  /** The TXT record that proves control of the domain (on it, or on _fudislte-verification.<domain>). */
  record: string
  /** People join automatically only once the domain is verified. */
  verifiedAt: string | null
}

export interface RoleInput {
  name?: string
  description?: string
  position?: number
  permissions?: Permission[]
}

export type ChannelVisibility = 'public' | 'private'

export interface Channel {
  id: string
  /**
   * "direct" conversations have no name, a fixed set of participants and no topic;
   * "room" is a secure room (see Room), reached through the room endpoints.
   */
  kind: 'channel' | 'direct' | 'room'
  name: string
  topic: string
  visibility: ChannelVisibility
  isDefault: boolean
  createdBy: string | null
  createdAt: string
  /** Archived channels are read-only. */
  archivedAt?: string
  memberCount: number
  /** The caller's membership: joined, read marker and unread messages (capped at 100). */
  joined: boolean
  lastReadId: string | null
  unreadCount: number
  /** Direct conversations: everyone in it, the caller included, sorted by name. */
  participants?: { id: string; displayName: string }[]
  /** Conversation lists: the newest message, shortened to 200 characters. */
  lastMessage?: Message
}

export interface ChannelInput {
  name: string
  topic?: string
  visibility: ChannelVisibility
  memberIds?: string[]
}

/** Who may enter a room (docs/architecture/phase-3.md). */
export type RoomAccess = 'open' | 'protected' | 'restricted'

/** A secure room, as the caller sees it. Its messages and files use the channel endpoints. */
export interface Room {
  id: string
  name: string
  topic: string
  access: RoomAccess
  hasPassword: boolean
  /** How long a password admission lasts. */
  admissionMinutes: number
  passwordChangedAt: string | null
  createdBy: string | null
  createdAt: string
  /** People admitted now. */
  memberCount: number
  admitted: boolean
  /** When the caller's admission ends; null lasts until they leave. */
  admissionExpiresAt: string | null
  /** The caller is on a restricted room's access list. */
  allowed: boolean
  canEnter: boolean
  needsPassword: boolean
  /** The caller may change settings (creator or rooms.manage); it does not admit them. */
  canManage: boolean
  unreadCount: number
  lastReadId: string | null
}

export interface RoomInput {
  name: string
  topic?: string
  access: RoomAccess
  password?: string
  admissionMinutes?: number
  /** Restricted rooms: who may enter besides the creator. */
  memberIds?: string[]
}

export interface RoomSecurityInput {
  access: RoomAccess
  /** A new password; empty keeps the current one unless removePassword is set. */
  password?: string
  removePassword?: boolean
}

export interface RoomPerson {
  user: { id: string; displayName: string }
  /** Admission or access-list date. */
  since: string
  expiresAt?: string | null
}

/** A LiveKit connection for one room or meeting (docs/decisions/0011). */
export interface VoiceTicket {
  url: string
  token: string
  /**
   * The token stops working for new connections then: it never outlives a room
   * admission, and a meeting's ends when its join window closes.
   */
  expiresAt: string
}

/** A scheduled voice and video meeting (docs/architecture/phase-4.md), as its organizer or an invitee sees it. */
export interface Meeting {
  id: string
  title: string
  agenda: string
  startsAt: string
  durationMinutes: number
  endsAt: string
  /** The organizer's IANA time zone; emails write times in it. */
  timeZone: string
  /** Null once the organizer has left the workspace. */
  organizer: Person | null
  /** Sorted by name; the organizer is not one of them. */
  invitees: Person[]
  createdAt: string
  updatedAt: string
  /** Canceled meetings stay listed; nobody can join them. */
  canceledAt: string | null
  /** The join window: 15 minutes before the start until 2 hours after the end. */
  opensAt: string
  closesAt: string
  /** The caller may edit, cancel and moderate the meeting. */
  isOrganizer: boolean
}

/** Upcoming: not yet ended, soonest first. Past: ended, most recent first. */
export type MeetingRange = 'upcoming' | 'past'

export interface MeetingInput {
  title?: string
  agenda?: string
  startsAt?: string
  durationMinutes?: number
  /** Replaces the invitation list; the organizer is never on it. */
  inviteeIds?: string[]
  /** The organizer's IANA time zone, e.g. Europe/Istanbul. */
  timeZone?: string
}

/** Someone connected to a room's or meeting's voice, as the server sees it. */
export interface VoiceParticipant {
  userId: string
  displayName: string
  muted: boolean
  camera: boolean
  screenShare: boolean
}

export interface VoiceState {
  /** False when the server has no LiveKit configured. */
  enabled: boolean
  participants: VoiceParticipant[]
}

export interface ChannelMember {
  user: { id: string; displayName: string }
  joinedAt: string
}

export interface Person {
  id: string
  displayName: string
}

/** A file sent with a message (docs/decisions/0009). */
export interface Attachment {
  id: string
  name: string
  /** Detected from the file's bytes. */
  contentType: string
  size: number
  /** PNG, JPEG, GIF or WebP: may be shown inline. */
  image: boolean
  createdAt: string
  /** Set in a channel's file list. */
  uploader?: Person
  messageId?: string
}

export interface SearchResult {
  message: Message
  channel: Channel
}

/** One emoji with everyone who chose it, earliest first. */
export interface Reaction {
  emoji: string
  users: Person[]
}

export interface Message {
  /** UUIDv7: sorting by ID is sorting by time. */
  id: string
  channelId: string
  /** Set on thread replies: the top-level message they answer. */
  parentId?: string
  /** Null when the author's account no longer exists. */
  author: Person | null
  /** Mentions appear as <@user-id> tokens; `mentions` names them. */
  body: string
  createdAt: string
  editedAt?: string
  /** A deleted thread root kept for its replies; body is empty. */
  deleted?: boolean
  mentions?: Person[]
  reactions?: Reaction[]
  pinned?: { at: string; by: Person | null }
  /** Top-level messages with replies. */
  thread?: { replyCount: number; lastReplyAt: string; latest: Message }
  attachments?: Attachment[]
}

export interface Thread {
  root: Message
  /** Oldest first. */
  replies: Message[]
}

export interface MessagePage {
  /** Oldest first. */
  messages: Message[]
  hasMore: boolean
}

export type StatusKind = 'meeting' | 'coding' | 'focus' | 'call' | 'custom'

/** What someone is doing. `mute` is only present on the person's own status. */
export interface UserStatus {
  kind: StatusKind
  text: string
  expiresAt?: string
  mute?: boolean
}

export interface StatusInput {
  kind: StatusKind
  text?: string
  expiresAt?: string | null
  mute?: boolean
}

export type PresenceState = 'online' | 'away' | 'offline'

export interface PresenceEntry {
  userId: string
  state: PresenceState
  status: UserStatus | null
}

export interface AppNotification {
  id: string
  kind: 'mention' | 'reply'
  channelId: string
  channelKind: 'channel' | 'direct' | 'room'
  /** Empty for direct conversations. */
  channelName: string
  actor: Person | null
  /** Shortened; `parentId` leads to the thread. */
  message: Message
  createdAt: string
  read: boolean
}

/** The palette projects, statuses and labels are drawn with. */
export type ProjectColor =
  | 'slate'
  | 'red'
  | 'orange'
  | 'amber'
  | 'green'
  | 'emerald'
  | 'teal'
  | 'sky'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'pink'

export type ProjectRole = 'lead' | 'member'

/** What a status means: tasks entering a "done" status are completed. */
export type StatusCategory = 'todo' | 'in_progress' | 'review' | 'done'

export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export type SprintState = 'planned' | 'active' | 'completed'

/** A project as the caller sees it (docs/architecture/phase-5.md). */
export interface Project {
  id: string
  /** 2–6 letters; task keys are "<key>-<number>". */
  key: string
  name: string
  description: string
  color: ProjectColor
  /** Private projects are visible to their members only. */
  visibility: ChannelVisibility
  status: 'active' | 'archived'
  /** Calendar dates, YYYY-MM-DD. */
  startsOn: string | null
  endsOn: string | null
  createdBy: string | null
  createdAt: string
  archivedAt: string | null
  memberCount: number
  taskCount: number
  doneCount: number
  /** Up to five members, leads first. */
  people: Person[]
  /** The caller's project role; empty for viewers of a public project. */
  role: ProjectRole | ''
  /** Create, edit and move tasks: members of an active project. */
  canEdit: boolean
  /** Settings, workflow, labels, members, sprints, archiving: leads and projects.manage. */
  canManage: boolean
}

export interface ProjectMember {
  user: Person
  role: ProjectRole
  addedAt: string
}

/** A workflow status: one board column. */
export interface WorkflowStatus {
  id: string
  name: string
  category: StatusCategory
  color: ProjectColor
  position: number
}

export interface ProjectLabel {
  id: string
  name: string
  color: ProjectColor
}

export interface Sprint {
  id: string
  name: string
  goal: string
  startsOn: string | null
  endsOn: string | null
  state: SprintState
  createdAt: string
  completedAt: string | null
  taskCount: number
  doneCount: number
}

export interface ProjectDetail extends Project {
  /** Leads first, then by name. */
  members: ProjectMember[]
  /** Left to right. */
  statuses: WorkflowStatus[]
  labels: ProjectLabel[]
  /** The active sprint, planned ones, then completed ones (latest first). */
  sprints: Sprint[]
}

export interface ProjectRef {
  id: string
  key: string
  name: string
  color: ProjectColor
}

/** POST and PATCH body; absent fields keep their value, null clears a date. */
export interface ProjectInput {
  key?: string
  name?: string
  description?: string
  color?: ProjectColor
  visibility?: ChannelVisibility
  startsOn?: string | null
  endsOn?: string | null
  /** Creation only: people who become members. */
  memberIds?: string[]
}

export interface Task {
  id: string
  project: ProjectRef
  number: number
  /** "ENG-42". */
  key: string
  title: string
  status: { id: string; name: string; category: StatusCategory; color: ProjectColor }
  priority: TaskPriority
  dueOn: string | null
  sprintId: string | null
  /** Orders a status column (fractional index, compared as plain strings). */
  rank: string
  assignees: Person[]
  labels: ProjectLabel[]
  checklist: { done: number; total: number }
  commentCount: number
  createdBy: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
  position: number
}

/** Plain text like messages, at most 4000 characters. */
export interface TaskComment {
  id: string
  author: Person | null
  body: string
  createdAt: string
  editedAt: string | null
}

/** A channel or room the task is linked to; only ones the caller may see are listed. */
export interface TaskLink {
  id: string
  kind: 'channel' | 'room'
  name: string
  joined: boolean
  createdAt: string
}

export type TaskActivityKind =
  | 'created'
  | 'status_changed'
  | 'assigned'
  | 'unassigned'
  | 'priority_changed'
  | 'due_changed'
  | 'sprint_changed'
  | 'title_changed'
  | 'description_changed'
  | 'labels_changed'
  | 'linked'
  | 'unlinked'

export interface TaskActivity {
  id: string
  kind: TaskActivityKind
  actor: Person | null
  /** Depends on the kind: from/to values, user, added/removed label names, channel. */
  data: Record<string, unknown>
  createdAt: string
  task?: { id: string; key: string; title: string }
}

export interface TaskDetail extends Task {
  description: string
  creator: Person | null
  checklistItems: ChecklistItem[]
  /** Oldest first. */
  comments: TaskComment[]
  links: TaskLink[]
  /** Newest first. */
  activity: TaskActivity[]
}

/** POST and PATCH body; absent fields keep their value, null clears the due date or sprint. */
export interface TaskInput {
  title?: string
  description?: string
  statusId?: string
  rank?: string
  priority?: TaskPriority
  dueOn?: string | null
  sprintId?: string | null
  assigneeIds?: string[]
  labelIds?: string[]
}

export interface SprintInput {
  name?: string
  goal?: string
  startsOn?: string | null
  endsOn?: string | null
}

/** A whiteboard (docs/architecture/phase-5.md). */
export interface Board {
  id: string
  title: string
  description: string
  /** Null for workspace boards. */
  project: ProjectRef | null
  /** The room linked for voice, only when the caller may see it. */
  room: { id: string; kind: 'room'; name: string; joined: boolean } | null
  createdBy: Person | null
  createdAt: string
  updatedAt: string
  elementCount: number
  canEdit: boolean
  canManage: boolean
}

export interface BoardInput {
  title?: string
  description?: string
  projectId?: string
  /** null removes the link. */
  roomId?: string | null
}

/** An Excalidraw element as stored; the server reads only these fields and keeps the rest. */
export interface BoardElement {
  id: string
  type: string
  version: number
  versionNonce: number
  isDeleted: boolean
  index?: string | null
  [field: string]: unknown
}

export interface BoardViewer {
  user: Person
  since: string
}

export interface BoardCursor {
  clientId: string
  x: number
  y: number
  tool: 'pointer' | 'laser'
  button: 'up' | 'down'
  selectedElementIds?: string[]
}

/** Events of GET /api/v1/events, by name (docs/decisions/0008). */
export interface LiveEvents {
  'message.created': { orgId: string; channelId: string; message: Message }
  'message.updated': { orgId: string; channelId: string; message: Message }
  'message.deleted': { orgId: string; channelId: string; messageId: string; parentId: string | null }
  'message.reactions': { orgId: string; channelId: string; messageId: string; parentId: string | null; reactions: Reaction[] }
  'channel.updated': { orgId: string; channelId: string; name: string; topic: string }
  'channel.joined': { orgId: string; channelId: string }
  'channel.members': { orgId: string; channelId: string; memberCount: number }
  'channel.archived': { orgId: string; channelId: string; archived: boolean }
  'channel.left': { orgId: string; channelId: string }
  'channel.read': { orgId: string; channelId: string; lastReadId: string }
  /** A room's settings changed; refetch it. */
  'room.updated': { orgId: string; roomId: string }
  /** A meeting was created, changed or canceled, or the caller was taken off its list; refetch it. */
  'meeting.updated': { orgId: string; meetingId: string }
  /** Who is in a room's voice (roomId) or a meeting's call (meetingId) now. */
  'voice.updated': { orgId: string; roomId?: string; meetingId?: string; participants: VoiceParticipant[] }
  /** A task was created or changed; it goes to everyone who may see the project. */
  'task.updated': { orgId: string; projectId: string; task: Task }
  'task.deleted': { orgId: string; projectId: string; taskId: string }
  /** Settings, workflow, labels, members or sprints changed, or the caller lost access; refetch. */
  'project.updated': { orgId: string; projectId: string }
  /** The tasks linked to a channel or room changed; refetch them. */
  'channel.tasks': { orgId: string; channelId: string }
  /** Whiteboards: only to people viewing the board who may see it. */
  'board.elements': { orgId: string; boardId: string; clientId: string; user: Person; elements: BoardElement[] }
  'board.cursor': {
    orgId: string
    boardId: string
    clientId: string
    user: Person
    pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
    button: 'up' | 'down'
    selectedElementIds: string[]
  }
  'board.viewers': { orgId: string; boardId: string; viewers: BoardViewer[] }
  'board.updated': { orgId: string; boardId: string }
  'board.deleted': { orgId: string; boardId: string }
  /** The first event of every stream. */
  ready: { connectionId: string }
  'presence.changed': PresenceEntry
  typing: { orgId: string; channelId: string; parentId: string | null; user: Person }
  'notification.created': { orgId: string; notification: AppNotification }
  'notification.read': { orgId: string }
}
