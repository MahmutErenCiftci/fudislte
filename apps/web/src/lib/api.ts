import { ApiError, createApiClient, type MeetingRange } from '@fudislte/api-client'
import { QueryCache, QueryClient } from '@tanstack/react-query'

import { getLanguage, t } from '../i18n'

/** Same-origin client: the web app is always served by the FUDISLTE server it talks to. */
export const api = createApiClient({ language: getLanguage })

export const queryKeys = {
  meta: ['meta'] as const,
  me: ['me'] as const,
  sessions: ['me', 'sessions'] as const,
  permissions: ['permissions'] as const,
  members: (orgId: string) => ['orgs', orgId, 'members'] as const,
  roles: (orgId: string) => ['orgs', orgId, 'roles'] as const,
  invitations: (orgId: string) => ['orgs', orgId, 'invitations'] as const,
  accessKeys: (orgId: string) => ['orgs', orgId, 'access-keys'] as const,
  sessionPolicy: ['instance', 'session-policy'] as const,
  registration: ['instance', 'registration'] as const,
  domains: (orgId: string) => ['orgs', orgId, 'domains'] as const,
  audit: (orgId: string) => ['orgs', orgId, 'audit'] as const,
  invitation: (token: string) => ['invitation', token] as const,
  /** Joined channels with unread counts; kept current by live events. */
  channels: (orgId: string) => ['orgs', orgId, 'channels'] as const,
  browseChannels: (orgId: string) => ['orgs', orgId, 'browse-channels'] as const,
  /** Direct conversations, newest activity first; kept current by live events. */
  conversations: (orgId: string) => ['orgs', orgId, 'conversations'] as const,
  channel: (orgId: string, channelId: string) => ['orgs', orgId, 'channel', channelId] as const,
  channelMembers: (orgId: string, channelId: string) => ['orgs', orgId, 'channel-members', channelId] as const,
  messages: (orgId: string, channelId: string) => ['orgs', orgId, 'messages', channelId] as const,
  /** All open threads of a channel share this prefix. */
  threads: (orgId: string, channelId: string) => ['orgs', orgId, 'thread', channelId] as const,
  thread: (orgId: string, channelId: string, rootId: string) => ['orgs', orgId, 'thread', channelId, rootId] as const,
  pins: (orgId: string, channelId: string) => ['orgs', orgId, 'pins', channelId] as const,
  presence: (orgId: string) => ['orgs', orgId, 'presence'] as const,
  files: (orgId: string, channelId: string) => ['orgs', orgId, 'files', channelId] as const,
  search: (orgId: string, query: string, channelId?: string) => ['orgs', orgId, 'search', query, channelId ?? ''] as const,
  retention: (orgId: string) => ['orgs', orgId, 'retention'] as const,
  notifications: (orgId: string) => ['orgs', orgId, 'notifications'] as const,
  /** Rooms the caller can enter; kept current by live events. */
  rooms: (orgId: string) => ['orgs', orgId, 'rooms'] as const,
  /** Every room of the workspace, for room managers. */
  allRooms: (orgId: string) => ['orgs', orgId, 'rooms', 'all'] as const,
  room: (orgId: string, roomId: string) => ['orgs', orgId, 'room', roomId] as const,
  roomMembers: (orgId: string, roomId: string) => ['orgs', orgId, 'room-members', roomId] as const,
  roomAccess: (orgId: string, roomId: string) => ['orgs', orgId, 'room-access', roomId] as const,
  /** Who is in a room's voice; kept current by voice.updated events. */
  voice: (orgId: string, roomId: string) => ['orgs', orgId, 'voice', roomId] as const,
  /** Every list of the caller's meetings; meeting.updated events refetch them. */
  meetings: (orgId: string) => ['orgs', orgId, 'meetings'] as const,
  meetingList: (orgId: string, range: MeetingRange) => ['orgs', orgId, 'meetings', range] as const,
  meeting: (orgId: string, meetingId: string) => ['orgs', orgId, 'meeting', meetingId] as const,
  /** Who is in a meeting's call; kept current by voice.updated events. */
  meetingVoice: (orgId: string, meetingId: string) => ['orgs', orgId, 'meeting-voice', meetingId] as const,
  /** Every list of projects; project.updated events refetch them. */
  projects: (orgId: string) => ['orgs', orgId, 'projects'] as const,
  projectList: (orgId: string, archived: boolean) => ['orgs', orgId, 'projects', archived ? 'archived' : 'active'] as const,
  project: (orgId: string, projectId: string) => ['orgs', orgId, 'project', projectId] as const,
  /** A project's tasks; kept current by task.updated events. */
  projectTasks: (orgId: string, projectId: string) => ['orgs', orgId, 'project-tasks', projectId] as const,
  projectActivity: (orgId: string, projectId: string) => ['orgs', orgId, 'project-activity', projectId] as const,
  task: (orgId: string, taskId: string) => ['orgs', orgId, 'task', taskId] as const,
  /** The caller's assigned tasks across projects. */
  myTasks: (orgId: string) => ['orgs', orgId, 'my-tasks'] as const,
  taskSearch: (orgId: string, query: string) => ['orgs', orgId, 'task-search', query] as const,
  /** Tasks linked to a channel or room; channel.tasks events refetch them. */
  channelTasks: (orgId: string, channelId: string) => ['orgs', orgId, 'channel-tasks', channelId] as const,
  boards: (orgId: string) => ['orgs', orgId, 'boards'] as const,
  board: (orgId: string, boardId: string) => ['orgs', orgId, 'board', boardId] as const,
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    // A revoked or expired session surfaces as 401 on any request: drop the cached
    // identity so the auth guard sends the user to sign in.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        queryClient.setQueryData(queryKeys.me, null)
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failures, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
    },
  },
})

/** A message for the user. Server messages arrive already translated (Accept-Language). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'network_error') return t('errors.network')
    if (error.code === 'http_error') return t('errors.http', { status: error.status })
    return error.message
  }
  return t('errors.generic')
}

export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError ? error.fields : {}
}

/** Form-level message for errors that are not attached to a specific field. */
export function formError(error: unknown): string | undefined {
  if (!error) return undefined
  if (error instanceof ApiError && Object.keys(error.fields).length > 0) return undefined
  return errorMessage(error)
}
