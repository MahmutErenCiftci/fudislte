import type {
  AccessKey,
  AccessKeyInput,
  AppNotification,
  Attachment,
  AuditEvent,
  Board,
  BoardCursor,
  BoardElement,
  BoardInput,
  BoardViewer,
  Channel,
  ChannelInput,
  ChannelMember,
  Domain,
  Invitation,
  InvitationPreview,
  Me,
  Meeting,
  MeetingInput,
  MeetingRange,
  Member,
  Message,
  MessagePage,
  Meta,
  PresenceEntry,
  Project,
  ProjectDetail,
  ProjectInput,
  ProjectLabel,
  ProjectMember,
  ProjectRole,
  Reaction,
  Sprint,
  SprintInput,
  Task,
  TaskActivity,
  TaskDetail,
  TaskInput,
  WorkflowStatus,
  Room,
  RoomInput,
  RoomPerson,
  RoomSecurityInput,
  SearchResult,
  VoiceState,
  VoiceTicket,
  StatusInput,
  Thread,
  Organization,
  PermissionInfo,
  ProfileInput,
  RegistrationSettings,
  Role,
  RoleInput,
  RoleSummary,
  SessionInfo,
  SessionPolicy,
  SetupInput,
  User,
  UserStatus,
  Workspace,
} from './types'

/** An error response from the API, or a network failure (status 0). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly fields: Record<string, string>

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = fields
  }
}

export interface ApiClientOptions {
  /** Origin of the FUDISLTE server. Empty means same origin (browser and desktop shell). */
  baseUrl?: string
  fetch?: typeof fetch
  /** Current UI language, sent as Accept-Language so messages come back translated. */
  language?: () => string
}

interface ErrorBody {
  error?: { code?: string; message?: string; fields?: Record<string, string> }
}

const seg = encodeURIComponent

export function createApiClient(options: ApiClientOptions = {}) {
  const base = `${options.baseUrl ?? ''}/api/v1`
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  // A FormData body (file uploads) is sent as multipart; anything else as JSON.
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const form = typeof FormData !== 'undefined' && body instanceof FormData
    const headers: Record<string, string> = {}
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json'
    if (options.language) headers['Accept-Language'] = options.language()
    let res: Response
    try {
      res = await doFetch(base + path, {
        method,
        credentials: 'same-origin',
        headers,
        body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
      })
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the FUDISLTE server. Check your connection and try again.')
    }
    if (res.status === 204) {
      return undefined as T
    }
    const text = await res.text()
    let data: unknown
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = undefined
      }
    }
    if (!res.ok) {
      const err = (data as ErrorBody | undefined)?.error
      throw new ApiError(
        res.status,
        err?.code ?? 'http_error',
        err?.message ?? `The server responded with status ${res.status}.`,
        err?.fields ?? {},
      )
    }
    return data as T
  }

  const org = (orgId: string) => `/orgs/${seg(orgId)}`
  const channel = (orgId: string, channelId: string) => `${org(orgId)}/channels/${seg(channelId)}`
  const room = (orgId: string, roomId: string) => `${org(orgId)}/rooms/${seg(roomId)}`
  const meeting = (orgId: string, meetingId: string) => `${org(orgId)}/meetings/${seg(meetingId)}`
  const project = (orgId: string, projectId: string) => `${org(orgId)}/projects/${seg(projectId)}`
  const task = (orgId: string, projectId: string, taskId: string) => `${project(orgId, projectId)}/tasks/${seg(taskId)}`
  const board = (orgId: string, boardId: string) => `${org(orgId)}/boards/${seg(boardId)}`
  const detail = async (p: Promise<{ task: TaskDetail }>) => (await p).task

  return {
    meta: () => request<Meta>('GET', '/meta'),
    /** Emails a confirmation code to the future owner (also proves mail delivery works). */
    setupCode: (setupToken: string, email: string) => request<void>('POST', '/setup/code', { setupToken, email }),
    setup: (input: SetupInput) => request<{ user: User; organization: Organization }>('POST', '/setup', input),

    /** Emails a sign-in code if the address may sign in; the response is the same either way. */
    requestCode: (email: string) => request<void>('POST', '/auth/code', { email }),
    verifyCode: (email: string, code: string) =>
      request<{ user: User; newAccount: boolean }>('POST', '/auth/verify', { email, code }),
    logout: () => request<void>('POST', '/auth/logout'),
    /** Creates the prepared account and signs it in; a key works once. */
    redeemAccessKey: (key: string) =>
      request<{ user: User; organization: Organization }>('POST', '/auth/access-key', { key }),

    /** Instance administrators only. */
    sessionPolicy: async () => (await request<{ policy: SessionPolicy }>('GET', '/instance/session-policy')).policy,
    /** Applies to existing sessions too: a shorter lifetime ends older sign-ins at once. */
    updateSessionPolicy: (ttlHours: number) =>
      request<{ policy: SessionPolicy; endedSessions: number }>('PUT', '/instance/session-policy', { ttlHours }),
    /** Instance administrators only. */
    registration: async () =>
      (await request<{ registration: RegistrationSettings }>('GET', '/instance/registration')).registration,
    /** Turning it off withdraws the server's record from the registry. */
    updateRegistration: async (input: { enabled: boolean; organizationName?: string; contactEmail?: string }) =>
      (await request<{ registration: RegistrationSettings }>('PUT', '/instance/registration', input)).registration,

    me: () => request<Me>('GET', '/me'),
    updateProfile: (input: ProfileInput) => request<{ user: User }>('PATCH', '/me', input),
    sessions: async () => (await request<{ sessions: SessionInfo[] }>('GET', '/me/sessions')).sessions,
    revokeSession: (sessionId: string) => request<void>('DELETE', `/me/sessions/${seg(sessionId)}`),
    revokeOtherSessions: () => request<{ revokedSessions: number }>('DELETE', '/me/sessions'),

    permissions: async () => (await request<{ permissions: PermissionInfo[] }>('GET', '/permissions')).permissions,

    createOrganization: async (name: string) =>
      (await request<{ organization: Organization }>('POST', '/orgs', { name })).organization,
    organization: (orgId: string) => request<Workspace>('GET', org(orgId)),
    updateOrganization: async (orgId: string, name: string) =>
      (await request<{ organization: Organization }>('PATCH', org(orgId), { name })).organization,

    members: async (orgId: string) => (await request<{ members: Member[] }>('GET', `${org(orgId)}/members`)).members,
    updateMemberRole: async (orgId: string, userId: string, roleId: string) =>
      (await request<{ member: Member }>('PATCH', `${org(orgId)}/members/${seg(userId)}`, { roleId })).member,
    removeMember: (orgId: string, userId: string) => request<void>('DELETE', `${org(orgId)}/members/${seg(userId)}`),
    /** Instance administrators only: the account is disabled on the whole server. */
    setMemberDisabled: async (orgId: string, userId: string, disabled: boolean) =>
      (await request<{ member: Member }>('POST', `${org(orgId)}/members/${seg(userId)}/${disabled ? 'disable' : 'enable'}`)).member,

    roles: async (orgId: string) => (await request<{ roles: RoleSummary[] }>('GET', `${org(orgId)}/roles`)).roles,
    createRole: async (orgId: string, input: RoleInput) =>
      (await request<{ role: Role }>('POST', `${org(orgId)}/roles`, input)).role,
    updateRole: async (orgId: string, roleId: string, input: RoleInput) =>
      (await request<{ role: Role }>('PATCH', `${org(orgId)}/roles/${seg(roleId)}`, input)).role,
    deleteRole: (orgId: string, roleId: string) => request<void>('DELETE', `${org(orgId)}/roles/${seg(roleId)}`),

    invitations: async (orgId: string) =>
      (await request<{ invitations: Invitation[] }>('GET', `${org(orgId)}/invitations`)).invitations,
    createInvitation: (orgId: string, email: string, roleId: string) =>
      request<{ invitation: Invitation; token: string; emailQueued: boolean }>('POST', `${org(orgId)}/invitations`, {
        email,
        roleId,
      }),
    revokeInvitation: (orgId: string, invitationId: string) =>
      request<void>('DELETE', `${org(orgId)}/invitations/${seg(invitationId)}`),
    previewInvitation: async (token: string) =>
      (await request<{ invitation: InvitationPreview }>('GET', `/invitations/${seg(token)}`)).invitation,
    /** Emails a code to the invited address so a new person can prove they own it. */
    invitationCode: (token: string) => request<void>('POST', `/invitations/${seg(token)}/code`),
    /** New people send displayName and code; signed-in people send nothing. */
    acceptInvitation: async (token: string, input: { displayName?: string; code?: string } = {}) =>
      (await request<{ organization: Organization }>('POST', `/invitations/${seg(token)}/accept`, input)).organization,

    accessKeys: async (orgId: string) =>
      (await request<{ accessKeys: AccessKey[] }>('GET', `${org(orgId)}/access-keys`)).accessKeys,
    /** The key is returned once; only its hash is stored. */
    createAccessKey: (orgId: string, input: AccessKeyInput) =>
      request<{ accessKey: AccessKey; key: string }>('POST', `${org(orgId)}/access-keys`, input),
    revokeAccessKey: (orgId: string, keyId: string) => request<void>('DELETE', `${org(orgId)}/access-keys/${seg(keyId)}`),

    domains: async (orgId: string) => (await request<{ domains: Domain[] }>('GET', `${org(orgId)}/domains`)).domains,
    addDomain: async (orgId: string, domain: string, roleId: string) =>
      (await request<{ domain: Domain }>('POST', `${org(orgId)}/domains`, { domain, roleId })).domain,
    removeDomain: (orgId: string, domain: string) => request<void>('DELETE', `${org(orgId)}/domains/${seg(domain)}`),
    /** Checks the TXT record; returns every domain with its new state. */
    verifyDomain: async (orgId: string, domain: string) =>
      (await request<{ domains: Domain[] }>('POST', `${org(orgId)}/domains/${seg(domain)}/verify`)).domains,

    auditEvents: (orgId: string, before?: number) =>
      request<{ events: AuditEvent[]; nextBefore: number | null }>(
        'GET',
        `${org(orgId)}/audit-events${before ? `?before=${before}` : ''}`,
      ),

    /** The caller's direct conversations, newest activity first. */
    conversations: async (orgId: string) =>
      (await request<{ conversations: Channel[] }>('GET', `${org(orgId)}/conversations`)).conversations,
    /** Finds or creates the conversation between the caller and userIds (none: notes to self). */
    openConversation: async (orgId: string, userIds: string[]) =>
      (await request<{ conversation: Channel }>('POST', `${org(orgId)}/conversations`, { userIds })).conversation,

    /** Channels the caller has joined, default channel first. */
    channels: async (orgId: string) => (await request<{ channels: Channel[] }>('GET', `${org(orgId)}/channels`)).channels,
    /** Public channels, joined or not. */
    browseChannels: async (orgId: string) =>
      (await request<{ channels: Channel[] }>('GET', `${org(orgId)}/channels/browse`)).channels,
    channel: async (orgId: string, channelId: string) =>
      (await request<{ channel: Channel }>('GET', channel(orgId, channelId))).channel,
    createChannel: async (orgId: string, input: ChannelInput) =>
      (await request<{ channel: Channel }>('POST', `${org(orgId)}/channels`, input)).channel,
    updateChannel: async (orgId: string, channelId: string, input: { name?: string; topic?: string }) =>
      (await request<{ channel: Channel }>('PATCH', channel(orgId, channelId), input)).channel,
    joinChannel: async (orgId: string, channelId: string) =>
      (await request<{ channel: Channel }>('POST', `${channel(orgId, channelId)}/join`)).channel,
    leaveChannel: (orgId: string, channelId: string) => request<void>('POST', `${channel(orgId, channelId)}/leave`),
    channelMembers: async (orgId: string, channelId: string) =>
      (await request<{ members: ChannelMember[] }>('GET', `${channel(orgId, channelId)}/members`)).members,
    addChannelMembers: (orgId: string, channelId: string, userIds: string[]) =>
      request<{ added: number }>('POST', `${channel(orgId, channelId)}/members`, { userIds }),
    removeChannelMember: (orgId: string, channelId: string, userId: string) =>
      request<void>('DELETE', `${channel(orgId, channelId)}/members/${seg(userId)}`),
    markChannelRead: (orgId: string, channelId: string, messageId: string) =>
      request<void>('POST', `${channel(orgId, channelId)}/read`, { messageId }),
    /** Archived channels are read-only and leave the sidebar; restoring brings them back. */
    archiveChannel: async (orgId: string, channelId: string) =>
      (await request<{ channel: Channel }>('POST', `${channel(orgId, channelId)}/archive`)).channel,
    unarchiveChannel: async (orgId: string, channelId: string) =>
      (await request<{ channel: Channel }>('POST', `${channel(orgId, channelId)}/unarchive`)).channel,

    /** Uploads one file to a channel; send its ID with a message to share it. */
    uploadFile: async (orgId: string, channelId: string, file: Blob, name: string) => {
      const form = new FormData()
      form.append('file', file, name)
      return (await request<{ attachment: Attachment }>('POST', `${channel(orgId, channelId)}/files`, form)).attachment
    },
    /** Removes an upload that was not sent. */
    deleteUpload: (orgId: string, fileId: string) => request<void>('DELETE', `${org(orgId)}/files/${seg(fileId)}`),
    /** Files sent in a channel, newest first. */
    channelFiles: async (orgId: string, channelId: string) =>
      (await request<{ files: Attachment[] }>('GET', `${channel(orgId, channelId)}/files`)).files,
    /** Where a file is served; `download` asks for a download even for images. */
    fileUrl: (orgId: string, fileId: string, download = false) =>
      `${base}${org(orgId)}/files/${seg(fileId)}${download ? '?download=1' : ''}`,

    /** Messages matching every word of `q` (as prefixes), newest first. */
    search: async (orgId: string, input: { q: string; channelId?: string; authorId?: string; limit?: number }) => {
      const params = new URLSearchParams({ q: input.q })
      if (input.channelId) params.set('channelId', input.channelId)
      if (input.authorId) params.set('authorId', input.authorId)
      if (input.limit) params.set('limit', String(input.limit))
      return (await request<{ results: SearchResult[] }>('GET', `${org(orgId)}/search?${params}`)).results
    },

    /** Rooms the caller can enter; with all, every room (rooms.manage, settings only). */
    rooms: async (orgId: string, all = false) =>
      (await request<{ rooms: Room[] }>('GET', `${org(orgId)}/rooms${all ? '?all=true' : ''}`)).rooms,
    room: async (orgId: string, roomId: string) => (await request<{ room: Room }>('GET', room(orgId, roomId))).room,
    createRoom: async (orgId: string, input: RoomInput) =>
      (await request<{ room: Room }>('POST', `${org(orgId)}/rooms`, input)).room,
    updateRoom: async (orgId: string, roomId: string, input: { name?: string; topic?: string; admissionMinutes?: number }) =>
      (await request<{ room: Room }>('PATCH', room(orgId, roomId), input)).room,
    /** Changes access or password; ends every admission but the creator's. */
    setRoomSecurity: async (orgId: string, roomId: string, input: RoomSecurityInput) =>
      (await request<{ room: Room }>('PUT', `${room(orgId, roomId)}/security`, input)).room,
    roomAccess: async (orgId: string, roomId: string) =>
      (await request<{ people: RoomPerson[] }>('GET', `${room(orgId, roomId)}/access`)).people,
    setRoomAccess: async (orgId: string, roomId: string, userIds: string[]) =>
      (await request<{ people: RoomPerson[] }>('PUT', `${room(orgId, roomId)}/access`, { userIds })).people,
    enterRoom: async (orgId: string, roomId: string, password = '') =>
      (await request<{ room: Room }>('POST', `${room(orgId, roomId)}/enter`, { password })).room,
    leaveRoom: (orgId: string, roomId: string) => request<void>('POST', `${room(orgId, roomId)}/leave`),
    roomMembers: async (orgId: string, roomId: string) =>
      (await request<{ people: RoomPerson[] }>('GET', `${room(orgId, roomId)}/members`)).people,
    endAdmission: (orgId: string, roomId: string, userId: string) =>
      request<void>('DELETE', `${room(orgId, roomId)}/members/${seg(userId)}`),
    deleteRoom: (orgId: string, roomId: string) => request<void>('DELETE', room(orgId, roomId)),
    /** A LiveKit token for the room's voice; only for people admitted. */
    joinVoice: async (orgId: string, roomId: string) =>
      (await request<{ voice: VoiceTicket }>('POST', `${room(orgId, roomId)}/voice`)).voice,
    voiceState: (orgId: string, roomId: string) => request<VoiceState>('GET', `${room(orgId, roomId)}/voice`),
    /** Room managers: mute someone's microphone, or disconnect them from voice. */
    muteInVoice: (orgId: string, roomId: string, userId: string) =>
      request<void>('POST', `${room(orgId, roomId)}/voice/${seg(userId)}/mute`),
    removeFromVoice: (orgId: string, roomId: string, userId: string) =>
      request<void>('DELETE', `${room(orgId, roomId)}/voice/${seg(userId)}`),

    /** Meetings the caller organizes or is invited to. */
    meetings: async (orgId: string, range: MeetingRange = 'upcoming') =>
      (await request<{ meetings: Meeting[] }>('GET', `${org(orgId)}/meetings?range=${range}`)).meetings,
    meeting: async (orgId: string, meetingId: string) =>
      (await request<{ meeting: Meeting }>('GET', meeting(orgId, meetingId))).meeting,
    /** Schedules a meeting (meetings.create); invitees are emailed a calendar invitation. */
    createMeeting: async (orgId: string, input: MeetingInput) =>
      (await request<{ meeting: Meeting }>('POST', `${org(orgId)}/meetings`, input)).meeting,
    /** The organizer only. A new time re-sends the invitation; removed invitees get a cancellation. */
    updateMeeting: async (orgId: string, meetingId: string, input: MeetingInput) =>
      (await request<{ meeting: Meeting }>('PATCH', meeting(orgId, meetingId), input)).meeting,
    /** The organizer only; the meeting stays listed as canceled. */
    cancelMeeting: async (orgId: string, meetingId: string) =>
      (await request<{ meeting: Meeting }>('DELETE', meeting(orgId, meetingId))).meeting,
    /** A LiveKit token for the meeting's call; only while its join window is open. */
    joinMeetingVoice: async (orgId: string, meetingId: string) =>
      (await request<{ voice: VoiceTicket }>('POST', `${meeting(orgId, meetingId)}/voice`)).voice,
    meetingVoiceState: (orgId: string, meetingId: string) => request<VoiceState>('GET', `${meeting(orgId, meetingId)}/voice`),
    /** The organizer: mute someone's microphone, or disconnect them from the call. */
    muteInMeeting: (orgId: string, meetingId: string, userId: string) =>
      request<void>('POST', `${meeting(orgId, meetingId)}/voice/${seg(userId)}/mute`),
    removeFromMeeting: (orgId: string, meetingId: string, userId: string) =>
      request<void>('DELETE', `${meeting(orgId, meetingId)}/voice/${seg(userId)}`),

    /** Projects the caller may see (docs/architecture/phase-5.md); archived ones on request. */
    projects: async (orgId: string, archived = false) =>
      (await request<{ projects: Project[] }>('GET', `${org(orgId)}/projects${archived ? '?archived=true' : ''}`)).projects,
    project: async (orgId: string, projectId: string) =>
      (await request<{ project: ProjectDetail }>('GET', project(orgId, projectId))).project,
    /** projects.create; the caller leads the project, which starts with the default workflow. */
    createProject: async (orgId: string, input: ProjectInput) =>
      (await request<{ project: ProjectDetail }>('POST', `${org(orgId)}/projects`, input)).project,
    updateProject: async (orgId: string, projectId: string, input: ProjectInput) =>
      (await request<{ project: ProjectDetail }>('PATCH', project(orgId, projectId), input)).project,
    /** Archived projects are read-only until restored. */
    archiveProject: async (orgId: string, projectId: string, archived: boolean) =>
      (await request<{ project: ProjectDetail }>('POST', `${project(orgId, projectId)}/${archived ? 'archive' : 'unarchive'}`))
        .project,
    /** Public projects: become a member. */
    joinProject: async (orgId: string, projectId: string) =>
      (await request<{ members: ProjectMember[] }>('POST', `${project(orgId, projectId)}/join`)).members,
    addProjectMembers: async (orgId: string, projectId: string, userIds: string[], role: ProjectRole = 'member') =>
      (await request<{ members: ProjectMember[] }>('POST', `${project(orgId, projectId)}/members`, { userIds, role })).members,
    setProjectRole: async (orgId: string, projectId: string, userId: string, role: ProjectRole) =>
      (await request<{ members: ProjectMember[] }>('PATCH', `${project(orgId, projectId)}/members/${seg(userId)}`, { role }))
        .members,
    /** Removes someone (leads and managers), or the caller leaves. */
    removeProjectMember: (orgId: string, projectId: string, userId: string) =>
      request<unknown>('DELETE', `${project(orgId, projectId)}/members/${seg(userId)}`).then(() => undefined),
    /** The latest task activity of the project, newest first. */
    projectActivity: async (orgId: string, projectId: string) =>
      (await request<{ events: TaskActivity[] }>('GET', `${project(orgId, projectId)}/activity`)).events,

    createStatus: async (orgId: string, projectId: string, input: Partial<Pick<WorkflowStatus, 'name' | 'category' | 'color'>>) =>
      (await request<{ status: WorkflowStatus }>('POST', `${project(orgId, projectId)}/statuses`, input)).status,
    updateStatus: async (
      orgId: string,
      projectId: string,
      statusId: string,
      input: Partial<Pick<WorkflowStatus, 'name' | 'category' | 'color'>>,
    ) => (await request<{ status: WorkflowStatus }>('PATCH', `${project(orgId, projectId)}/statuses/${seg(statusId)}`, input)).status,
    /** Its tasks move to moveTo (required when it has any). */
    deleteStatus: (orgId: string, projectId: string, statusId: string, moveTo?: string) =>
      request<void>(
        'DELETE',
        `${project(orgId, projectId)}/statuses/${seg(statusId)}${moveTo ? `?moveTo=${seg(moveTo)}` : ''}`,
      ),
    reorderStatuses: async (orgId: string, projectId: string, statusIds: string[]) =>
      (await request<{ statuses: WorkflowStatus[] }>('PUT', `${project(orgId, projectId)}/statuses/order`, { statusIds }))
        .statuses,
    createLabel: async (orgId: string, projectId: string, input: Partial<Pick<ProjectLabel, 'name' | 'color'>>) =>
      (await request<{ label: ProjectLabel }>('POST', `${project(orgId, projectId)}/labels`, input)).label,
    updateLabel: async (orgId: string, projectId: string, labelId: string, input: Partial<Pick<ProjectLabel, 'name' | 'color'>>) =>
      (await request<{ label: ProjectLabel }>('PATCH', `${project(orgId, projectId)}/labels/${seg(labelId)}`, input)).label,
    deleteLabel: (orgId: string, projectId: string, labelId: string) =>
      request<void>('DELETE', `${project(orgId, projectId)}/labels/${seg(labelId)}`),

    createSprint: async (orgId: string, projectId: string, input: SprintInput) =>
      (await request<{ sprint: Sprint }>('POST', `${project(orgId, projectId)}/sprints`, input)).sprint,
    updateSprint: async (orgId: string, projectId: string, sprintId: string, input: SprintInput) =>
      (await request<{ sprint: Sprint }>('PATCH', `${project(orgId, projectId)}/sprints/${seg(sprintId)}`, input)).sprint,
    /** One active sprint per project. */
    startSprint: async (orgId: string, projectId: string, sprintId: string) =>
      (await request<{ sprint: Sprint }>('POST', `${project(orgId, projectId)}/sprints/${seg(sprintId)}/start`)).sprint,
    /** Unfinished tasks go back to the backlog. */
    completeSprint: async (orgId: string, projectId: string, sprintId: string) =>
      (await request<{ sprint: Sprint }>('POST', `${project(orgId, projectId)}/sprints/${seg(sprintId)}/complete`)).sprint,
    deleteSprint: (orgId: string, projectId: string, sprintId: string) =>
      request<void>('DELETE', `${project(orgId, projectId)}/sprints/${seg(sprintId)}`),

    /** Every task of a project; each column in rank order. */
    tasks: async (orgId: string, projectId: string) =>
      (await request<{ tasks: Task[] }>('GET', `${project(orgId, projectId)}/tasks`)).tasks,
    task: (orgId: string, projectId: string, taskId: string) =>
      detail(request<{ task: TaskDetail }>('GET', task(orgId, projectId, taskId))),
    createTask: (orgId: string, projectId: string, input: TaskInput) =>
      detail(request<{ task: TaskDetail }>('POST', `${project(orgId, projectId)}/tasks`, input)),
    /** A statusId without rank appends to that column. */
    updateTask: (orgId: string, projectId: string, taskId: string, input: TaskInput) =>
      detail(request<{ task: TaskDetail }>('PATCH', task(orgId, projectId, taskId), input)),
    deleteTask: (orgId: string, projectId: string, taskId: string) => request<void>('DELETE', task(orgId, projectId, taskId)),
    addChecklistItem: (orgId: string, projectId: string, taskId: string, text: string) =>
      detail(request<{ task: TaskDetail }>('POST', `${task(orgId, projectId, taskId)}/checklist`, { text })),
    updateChecklistItem: (orgId: string, projectId: string, taskId: string, itemId: string, input: { text?: string; done?: boolean }) =>
      detail(request<{ task: TaskDetail }>('PATCH', `${task(orgId, projectId, taskId)}/checklist/${seg(itemId)}`, input)),
    deleteChecklistItem: (orgId: string, projectId: string, taskId: string, itemId: string) =>
      detail(request<{ task: TaskDetail }>('DELETE', `${task(orgId, projectId, taskId)}/checklist/${seg(itemId)}`)),
    addTaskComment: (orgId: string, projectId: string, taskId: string, body: string) =>
      detail(request<{ task: TaskDetail }>('POST', `${task(orgId, projectId, taskId)}/comments`, { body })),
    editTaskComment: (orgId: string, projectId: string, taskId: string, commentId: string, body: string) =>
      detail(request<{ task: TaskDetail }>('PATCH', `${task(orgId, projectId, taskId)}/comments/${seg(commentId)}`, { body })),
    deleteTaskComment: (orgId: string, projectId: string, taskId: string, commentId: string) =>
      detail(request<{ task: TaskDetail }>('DELETE', `${task(orgId, projectId, taskId)}/comments/${seg(commentId)}`)),
    /** Links the task to a channel the caller joined or a room they are in. */
    linkTask: (orgId: string, projectId: string, taskId: string, channelId: string) =>
      detail(request<{ task: TaskDetail }>('POST', `${task(orgId, projectId, taskId)}/links`, { channelId })),
    unlinkTask: (orgId: string, projectId: string, taskId: string, channelId: string) =>
      detail(request<{ task: TaskDetail }>('DELETE', `${task(orgId, projectId, taskId)}/links/${seg(channelId)}`)),
    /** The caller's assigned tasks: open ones, and ones completed in the last seven days. */
    myTasks: async (orgId: string) => (await request<{ tasks: Task[] }>('GET', `${org(orgId)}/tasks`)).tasks,
    /** Tasks of active projects the caller may see, by title or key ("ENG-42"). */
    searchTasks: async (orgId: string, q: string) =>
      (await request<{ tasks: Task[] }>('GET', `${org(orgId)}/tasks?q=${seg(q)}`)).tasks,
    /** Tasks linked to a channel, or to a room the caller is in, that the caller may see. */
    channelTasks: async (orgId: string, channelId: string) =>
      (await request<{ tasks: Task[] }>('GET', `${channel(orgId, channelId)}/tasks`)).tasks,

    /** Whiteboards the caller may see, most recently changed first. */
    boards: async (orgId: string, projectId?: string) =>
      (await request<{ boards: Board[] }>('GET', `${org(orgId)}/boards${projectId ? `?projectId=${seg(projectId)}` : ''}`)).boards,
    /** The board with its merged scene; deleted elements too when merging after a reconnect. */
    board: (orgId: string, boardId: string, includeDeleted = false) =>
      request<{ board: Board; elements: BoardElement[] }>('GET', `${board(orgId, boardId)}${includeDeleted ? '?deleted=true' : ''}`),
    createBoard: async (orgId: string, input: BoardInput) =>
      (await request<{ board: Board }>('POST', `${org(orgId)}/boards`, input)).board,
    updateBoard: async (orgId: string, boardId: string, input: BoardInput) =>
      (await request<{ board: Board }>('PATCH', board(orgId, boardId), input)).board,
    deleteBoard: (orgId: string, boardId: string) => request<void>('DELETE', board(orgId, boardId)),
    /** Sends changed elements; the server keeps the higher version of each and relays the accepted ones. */
    saveBoardElements: async (orgId: string, boardId: string, clientId: string, elements: readonly BoardElement[]) =>
      (await request<{ accepted: number }>('PATCH', `${board(orgId, boardId)}/elements`, { clientId, elements })).accepted,
    /** Keeps this window listed as viewing the board (send every ~10 s); returns who views it. */
    boardHeartbeat: async (orgId: string, boardId: string, clientId: string) =>
      (await request<{ viewers: BoardViewer[] }>('POST', `${board(orgId, boardId)}/presence`, { clientId })).viewers,
    leaveBoard: (orgId: string, boardId: string, clientId: string) =>
      request<void>('DELETE', `${board(orgId, boardId)}/presence?clientId=${seg(clientId)}`),
    /** Relays the pointer to the other viewers; never stored. */
    boardCursor: (orgId: string, boardId: string, cursor: BoardCursor) =>
      request<void>('POST', `${board(orgId, boardId)}/cursor`, cursor),

    /** Message retention in days; null keeps messages forever. */
    retention: async (orgId: string) => (await request<{ days: number | null }>('GET', `${org(orgId)}/retention`)).days,
    setRetention: async (orgId: string, days: number | null) =>
      (await request<{ days: number | null }>('PUT', `${org(orgId)}/retention`, { days })).days,

    /** One page of history; pass the oldest loaded message ID as `before` for older ones. */
    messages: (orgId: string, channelId: string, before?: string) =>
      request<MessagePage>('GET', `${channel(orgId, channelId)}/messages${before ? `?before=${seg(before)}` : ''}`),
    /** Sends a message; with parentId a reply in that message's thread. */
    sendMessage: async (orgId: string, channelId: string, body: string, parentId?: string, attachmentIds?: string[]) =>
      (
        await request<{ message: Message }>('POST', `${channel(orgId, channelId)}/messages`, {
          body,
          ...(parentId && { parentId }),
          ...(attachmentIds?.length && { attachmentIds }),
        })
      ).message,
    replies: (orgId: string, channelId: string, messageId: string) =>
      request<Thread>('GET', `${channel(orgId, channelId)}/messages/${seg(messageId)}/replies`),
    addReaction: async (orgId: string, channelId: string, messageId: string, emoji: string) =>
      (await request<{ reactions: Reaction[] }>('POST', `${channel(orgId, channelId)}/messages/${seg(messageId)}/reactions`, { emoji }))
        .reactions,
    removeReaction: async (orgId: string, channelId: string, messageId: string, emoji: string) =>
      (
        await request<{ reactions: Reaction[] }>(
          'DELETE',
          `${channel(orgId, channelId)}/messages/${seg(messageId)}/reactions?emoji=${seg(emoji)}`,
        )
      ).reactions,
    pinMessage: async (orgId: string, channelId: string, messageId: string) =>
      (await request<{ message: Message }>('PUT', `${channel(orgId, channelId)}/messages/${seg(messageId)}/pin`)).message,
    unpinMessage: async (orgId: string, channelId: string, messageId: string) =>
      (await request<{ message: Message }>('DELETE', `${channel(orgId, channelId)}/messages/${seg(messageId)}/pin`)).message,
    /** Pinned messages, most recently pinned first. */
    pins: async (orgId: string, channelId: string) =>
      (await request<{ messages: Message[] }>('GET', `${channel(orgId, channelId)}/pins`)).messages,
    editMessage: async (orgId: string, channelId: string, messageId: string, body: string) =>
      (await request<{ message: Message }>('PATCH', `${channel(orgId, channelId)}/messages/${seg(messageId)}`, { body }))
        .message,
    deleteMessage: (orgId: string, channelId: string, messageId: string) =>
      request<void>('DELETE', `${channel(orgId, channelId)}/messages/${seg(messageId)}`),

    /** Lets the server tell others typing is happening; call at most every few seconds. */
    typing: (orgId: string, channelId: string, parentId?: string) =>
      request<void>('POST', `${channel(orgId, channelId)}/typing`, parentId ? { parentId } : {}),

    /** Presence and status of every workspace member (needs members.view). */
    presence: async (orgId: string) => (await request<{ presence: PresenceEntry[] }>('GET', `${org(orgId)}/presence`)).presence,
    /** Reports whether the window behind an event stream is in use. */
    reportActivity: (connectionId: string, active: boolean) => request<void>('POST', '/presence', { connectionId, active }),
    setStatus: async (input: StatusInput) => (await request<{ status: UserStatus }>('PUT', '/me/status', input)).status,
    clearStatus: () => request<void>('DELETE', '/me/status'),

    notifications: (orgId: string) =>
      request<{ notifications: AppNotification[]; unreadCount: number }>('GET', `${org(orgId)}/notifications`),
    /** Marks notifications read by ID, by channel, or all. */
    readNotifications: (orgId: string, input: { ids?: string[]; channelId?: string; all?: boolean }) =>
      request<{ unreadCount: number }>('POST', `${org(orgId)}/notifications/read`, input),

    /** URL of the live event stream (Server-Sent Events, same-origin cookie auth). */
    eventsUrl: () => `${base}/events`,
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
