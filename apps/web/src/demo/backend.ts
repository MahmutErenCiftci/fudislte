// In-browser stand-in for the FUDISLTE API, used only by the demo build. It keeps the
// sample workspace in memory (a reload starts over), answers /api/v1 requests the way
// services/api does, and pushes live events to the fake event stream.

import type {
  AppNotification,
  Channel,
  LiveEvents,
  Me,
  Member,
  Message,
  Person,
  PresenceEntry,
  Reaction,
  Role,
  UserStatus,
} from '@fudislte/api-client'

import { channels as seedChannels, type DemoLanguage, ME, people, replies, workspaceName, workspaceSlug } from './seed'

// ---------------------------------------------------------------------------- ids

let lastMs = 0
/**
 * UUIDv7-shaped IDs: comparing them as strings compares their times, like the server's.
 * Without a time they are "now" and strictly increasing; with one they encode that time.
 */
function newId(at?: number): string {
  const ms = at ?? (lastMs = Math.max(Date.now(), lastMs + 1))
  const ts = ms.toString(16).padStart(12, '0')
  const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${rnd(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${rnd(3)}-${rnd(12)}`
}

// -------------------------------------------------------------------------- state

interface ChannelRec {
  id: string
  kind: 'channel' | 'direct'
  name: string
  topic: string
  visibility: 'public' | 'private'
  isDefault: boolean
  createdBy: string
  createdAt: string
  archivedAt?: string
  members: Set<string>
  lastRead: Map<string, string | null>
}

interface MessageRec {
  id: string
  channelId: string
  parentId?: string
  authorId: string
  body: string
  createdAt: string
  editedAt?: string
  deleted?: boolean
  reactions: { emoji: string; userIds: string[] }[]
  pinned?: { at: string; by: string }
}

interface PersonRec {
  id: string
  displayName: string
  email: string
  roleKey: 'owner' | 'member'
  presence: 'online' | 'away' | 'offline'
  status: UserStatus | null
  joinedAt: string
}

interface State {
  lang: DemoLanguage
  orgId: string
  createdAt: string
  people: Map<string, PersonRec>
  channels: Map<string, ChannelRec>
  messages: Map<string, MessageRec[]>
  notifications: AppNotification[]
}

let state: State | null = null

function seed(lang: DemoLanguage): State {
  const now = Date.now()
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const s: State = {
    lang,
    orgId: '0b000000-0000-4000-8000-000000000001',
    createdAt: iso(60 * 24 * 30),
    people: new Map(),
    channels: new Map(),
    messages: new Map(),
    notifications: [],
  }
  people.forEach((p, i) =>
    s.people.set(p.id, {
      id: p.id,
      displayName: p.name[lang],
      email: p.email,
      roleKey: p.roleKey,
      presence: p.presence,
      status: p.status ? { kind: p.status.kind, text: p.status.text[lang] } : null,
      joinedAt: iso(60 * 24 * (30 - i)),
    }),
  )
  for (const c of seedChannels) {
    const oldest = Math.max(...c.messages.map((m) => m.ago), 0)
    const rec: ChannelRec = {
      id: c.id,
      kind: c.kind,
      name: c.name[lang],
      topic: c.topic[lang],
      visibility: c.visibility,
      isDefault: !!c.isDefault,
      createdBy: c.createdBy,
      createdAt: iso(oldest + 60),
      members: new Set(c.members),
      lastRead: new Map(),
    }
    const keys = new Map<string, string>()
    const list: MessageRec[] = []
    for (const m of [...c.messages].sort((a, b) => b.ago - a.ago)) {
      const at = now - m.ago * 60_000
      const id = newId(at)
      if (m.key) keys.set(m.key, id)
      list.push({
        id,
        channelId: c.id,
        parentId: m.replyTo ? keys.get(m.replyTo) : undefined,
        authorId: m.author,
        body: m.text[lang],
        createdAt: new Date(at).toISOString(),
        reactions: (m.reactions ?? []).map(([emoji, userIds]) => ({ emoji, userIds })),
        pinned: m.pinnedBy ? { at: new Date(at + 60_000).toISOString(), by: m.pinnedBy } : undefined,
      })
    }
    // Everyone has read everything, except the demo user's unread tail.
    const top = list.filter((m) => !m.parentId)
    for (const member of rec.members) rec.lastRead.set(member, top.at(-1)?.id ?? null)
    if (rec.members.has(ME)) {
      const unread = c.unread ?? 0
      rec.lastRead.set(ME, unread > 0 ? (top.at(-1 - unread)?.id ?? null) : (top.at(-1)?.id ?? null))
    }
    s.channels.set(rec.id, rec)
    s.messages.set(rec.id, list)
  }
  return s
}

/** Mentions of the demo user in the sample messages become unread notifications. */
function seedNotifications() {
  const s = st()
  for (const [channelId, list] of s.messages) {
    const ch = s.channels.get(channelId)!
    if (!ch.members.has(ME)) continue
    for (const m of list) {
      if (m.authorId === ME || !m.body.includes(`<@${ME}>`)) continue
      s.notifications.unshift({
        id: newId(Date.parse(m.createdAt)),
        kind: 'mention',
        channelId,
        channelKind: ch.kind,
        channelName: ch.kind === 'direct' ? '' : ch.name,
        actor: person(m.authorId),
        message: toMessage(m, false),
        createdAt: m.createdAt,
        read: false,
      })
    }
  }
}

function st(): State {
  if (!state) throw new Error('demo state not initialized')
  return state
}

// ------------------------------------------------------------------- live events

type Listener = (type: string, data: unknown) => void
const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit<K extends keyof LiveEvents>(type: K, data: LiveEvents[K]) {
  // After the HTTP response, like the server's stream.
  setTimeout(() => listeners.forEach((l) => l(type, data)), 0)
}

// --------------------------------------------------------------- serialization

const person = (id: string): Person | null => {
  const p = st().people.get(id)
  return p ? { id: p.id, displayName: p.displayName } : null
}

const roles = (): Record<'owner' | 'member', Role> => {
  const tr = st().lang === 'tr'
  return {
    owner: {
      id: '0e000000-0000-4000-8000-000000000001',
      key: 'owner',
      name: tr ? 'Sahip' : 'Owner',
      description: '',
      position: 0,
      permissions: [],
      isSystem: true,
    },
    member: {
      id: '0e000000-0000-4000-8000-000000000002',
      key: 'member',
      name: tr ? 'Üye' : 'Member',
      description: '',
      position: 1,
      // What a regular member may do; workspace administration is left out of the demo.
      permissions: ['members.view', 'channels.join', 'channels.create', 'rooms.join', 'meetings.create', 'projects.view', 'projects.create', 'boards.create'],
      isSystem: true,
    },
  }
}

const roleRef = (key: 'owner' | 'member') => {
  const r = roles()[key]
  return { id: r.id, key: r.key, name: r.name, position: r.position }
}

function userOf(id: string) {
  const p = st().people.get(id)!
  return {
    id: p.id,
    email: p.email,
    displayName: p.displayName,
    locale: st().lang,
    isInstanceAdmin: false,
    createdAt: p.joinedAt,
    ...(id === ME && p.status ? { status: p.status } : {}),
  }
}

function organization() {
  return { id: st().orgId, name: workspaceName[st().lang], slug: workspaceSlug, createdAt: st().createdAt }
}

function me(): Me {
  return { user: userOf(ME), workspaces: [{ organization: organization(), role: roles().member }] }
}

const MENTION = /<@([0-9a-f-]{36})>/g

function toMessage(m: MessageRec, withThread = true): Message {
  const mentionIds = [...new Set([...m.body.matchAll(MENTION)].map((x) => x[1]!))]
  const out: Message = {
    id: m.id,
    channelId: m.channelId,
    ...(m.parentId && { parentId: m.parentId }),
    author: person(m.authorId),
    body: m.deleted ? '' : m.body,
    createdAt: m.createdAt,
    ...(m.editedAt && { editedAt: m.editedAt }),
    ...(m.deleted && { deleted: true }),
    mentions: mentionIds.map(person).filter((p): p is Person => !!p),
    reactions: reactionsOf(m),
    ...(m.pinned && { pinned: { at: m.pinned.at, by: person(m.pinned.by) } }),
  }
  if (withThread && !m.parentId) {
    const replyList = repliesOf(m)
    const latest = replyList.at(-1)
    if (latest) out.thread = { replyCount: replyList.length, lastReplyAt: latest.createdAt, latest: toMessage(latest, false) }
  }
  return out
}

const reactionsOf = (m: MessageRec): Reaction[] =>
  m.reactions.map((r) => ({ emoji: r.emoji, users: r.userIds.map(person).filter((p): p is Person => !!p) }))

const messagesOf = (channelId: string) => st().messages.get(channelId) ?? []
const topLevel = (channelId: string) => messagesOf(channelId).filter((m) => !m.parentId)
const repliesOf = (root: MessageRec) => messagesOf(root.channelId).filter((m) => m.parentId === root.id)

function toChannel(c: ChannelRec, withLast = false): Channel {
  const joined = c.members.has(ME)
  const lastReadId = joined ? (c.lastRead.get(ME) ?? null) : null
  const unread = joined ? topLevel(c.id).filter((m) => m.authorId !== ME && (!lastReadId || m.id > lastReadId)).length : 0
  const last = topLevel(c.id).at(-1)
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    topic: c.topic,
    visibility: c.visibility,
    isDefault: c.isDefault,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    ...(c.archivedAt && { archivedAt: c.archivedAt }),
    memberCount: c.members.size,
    joined,
    lastReadId,
    unreadCount: Math.min(unread, 100),
    ...(c.kind === 'direct' && {
      participants: [...c.members]
        .map(person)
        .filter((p): p is Person => !!p)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }),
    ...(withLast && last && { lastMessage: { ...toMessage(last, false), body: last.body.slice(0, 200) } }),
  }
}

function presenceOf(p: PersonRec): PresenceEntry {
  const { mute: _mute, ...status } = p.status ?? ({} as UserStatus)
  return { userId: p.id, state: p.presence, status: p.status ? (status as UserStatus) : null }
}

// ------------------------------------------------------------------- responses

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const demoOff = () =>
  new HttpError(
    403,
    'demo',
    st().lang === 'tr'
      ? 'Bu özellik demoda kapalı. Kendi FUDISLTE sunucunuzda tamamen çalışır.'
      : 'This feature is turned off in the demo. It works fully on your own FUDISLTE server.',
  )
const notFound = () => new HttpError(404, 'not_found', st().lang === 'tr' ? 'Bulunamadı.' : 'Not found.')

function channelOr404(id: string): ChannelRec {
  const c = st().channels.get(id)
  if (!c || (c.kind === 'direct' && !c.members.has(ME))) throw notFound()
  return c
}

function messageOr404(channelId: string, id: string): MessageRec {
  const m = messagesOf(channelId).find((x) => x.id === id)
  if (!m) throw notFound()
  return m
}

// ---------------------------------------------------------------------- routes

type Body = Record<string, unknown>
interface Ctx {
  params: string[]
  query: URLSearchParams
  body: Body
}
type Handler = (ctx: Ctx) => unknown
const routes: { method: string; pattern: RegExp; handle: Handler }[] = []
const route = (method: string, path: string, handle: Handler) =>
  routes.push({ method, pattern: new RegExp(`^${path.replace(/:[a-z]+/gi, '([^/]+)')}$`), handle })

const NO_CONTENT = Symbol('no content')
const O = '/orgs/:org'
const C = `${O}/channels/:channel`

route('GET', '/meta', () => ({ product: 'fudislte', version: '0.1.2', setupRequired: false, registrationAvailable: false }))
route('GET', '/me', () => me())
route('PATCH', '/me', ({ body }) => {
  const p = st().people.get(ME)!
  if (typeof body.displayName === 'string' && body.displayName.trim()) p.displayName = body.displayName.trim()
  if (body.locale === 'tr' || body.locale === 'en') st().lang = body.locale
  return { user: userOf(ME) }
})
route('GET', '/me/sessions', () => ({
  sessions: [
    {
      id: 'demo-session',
      userAgent: navigator.userAgent,
      ipAddress: '127.0.0.1',
      createdAt: st().createdAt,
      lastSeenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
      current: true,
    },
  ],
}))
route('DELETE', '/me/sessions', () => ({ revokedSessions: 0 }))
route('PUT', '/me/status', ({ body }) => {
  const p = st().people.get(ME)!
  p.status = {
    kind: (body.kind as UserStatus['kind']) ?? 'custom',
    text: typeof body.text === 'string' ? body.text : '',
    ...(typeof body.expiresAt === 'string' && { expiresAt: body.expiresAt }),
    ...(typeof body.mute === 'boolean' && { mute: body.mute }),
  }
  emit('presence.changed', presenceOf(p))
  return { status: p.status }
})
route('DELETE', '/me/status', () => {
  const p = st().people.get(ME)!
  p.status = null
  emit('presence.changed', presenceOf(p))
  return NO_CONTENT
})
route('POST', '/presence', () => NO_CONTENT)
route('POST', '/auth/logout', () => {
  // Signing out of the demo starts it over.
  setTimeout(() => window.location.assign('/'), 100)
  return NO_CONTENT
})
route('GET', '/permissions', () => ({ permissions: [] }))

route('GET', O, () => ({ organization: organization(), role: roles().member }))
route('GET', `${O}/members`, () => ({
  members: [...st().people.values()].map(
    (p): Member => ({
      user: { id: p.id, displayName: p.displayName, email: p.email },
      role: roleRef(p.roleKey),
      joinedAt: p.joinedAt,
      disabled: false,
    }),
  ),
}))
route('GET', `${O}/roles`, () => ({
  roles: (['owner', 'member'] as const).map((k) => ({
    ...roles()[k],
    memberCount: [...st().people.values()].filter((p) => p.roleKey === k).length,
  })),
}))
route('GET', `${O}/presence`, () => ({ presence: [...st().people.values()].map(presenceOf) }))

route('GET', `${O}/notifications`, () => ({
  notifications: st().notifications,
  unreadCount: st().notifications.filter((n) => !n.read).length,
}))
route('POST', `${O}/notifications/read`, ({ body }) => {
  const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null
  for (const n of st().notifications) {
    if (body.all || ids?.includes(n.id) || (body.channelId && n.channelId === body.channelId)) n.read = true
  }
  emit('notification.read', { orgId: st().orgId })
  return { unreadCount: st().notifications.filter((n) => !n.read).length }
})

// Channels and conversations.
route('GET', `${O}/channels`, () => ({
  channels: [...st().channels.values()]
    .filter((c) => c.kind === 'channel' && c.members.has(ME) && !c.archivedAt)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
    .map((c) => toChannel(c)),
}))
route('GET', `${O}/channels/browse`, () => ({
  channels: [...st().channels.values()]
    .filter((c) => c.kind === 'channel' && (c.visibility === 'public' || c.members.has(ME)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => toChannel(c)),
}))
route('POST', `${O}/channels`, ({ body }) => {
  const name = String(body.name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
  if (!name) throw new HttpError(422, 'validation', st().lang === 'tr' ? 'Bir ad girin.' : 'Enter a name.')
  const members = new Set([ME, ...((body.memberIds as string[] | undefined) ?? [])])
  const rec: ChannelRec = {
    id: newId(),
    kind: 'channel',
    name,
    topic: String(body.topic ?? ''),
    visibility: body.visibility === 'private' ? 'private' : 'public',
    isDefault: false,
    createdBy: ME,
    createdAt: new Date().toISOString(),
    members,
    lastRead: new Map([...members].map((m) => [m, null])),
  }
  st().channels.set(rec.id, rec)
  st().messages.set(rec.id, [])
  emit('channel.joined', { orgId: st().orgId, channelId: rec.id })
  return { channel: toChannel(rec) }
})
route('GET', C, ({ params }) => ({ channel: toChannel(channelOr404(params[1]!)) }))
route('PATCH', C, ({ params, body }) => {
  const c = channelOr404(params[1]!)
  if (typeof body.name === 'string' && body.name.trim()) c.name = body.name.trim()
  if (typeof body.topic === 'string') c.topic = body.topic
  emit('channel.updated', { orgId: st().orgId, channelId: c.id, name: c.name, topic: c.topic })
  return { channel: toChannel(c) }
})
route('POST', `${C}/join`, ({ params }) => {
  const c = channelOr404(params[1]!)
  c.members.add(ME)
  c.lastRead.set(ME, topLevel(c.id).at(-1)?.id ?? null)
  emit('channel.joined', { orgId: st().orgId, channelId: c.id })
  emit('channel.members', { orgId: st().orgId, channelId: c.id, memberCount: c.members.size })
  return { channel: toChannel(c) }
})
route('POST', `${C}/leave`, ({ params }) => {
  const c = channelOr404(params[1]!)
  if (c.isDefault) throw new HttpError(422, 'default_channel', st().lang === 'tr' ? 'Varsayılan kanaldan ayrılamazsınız.' : 'You cannot leave the default channel.')
  c.members.delete(ME)
  emit('channel.left', { orgId: st().orgId, channelId: c.id })
  return NO_CONTENT
})
route('POST', `${C}/archive`, ({ params }) => {
  const c = channelOr404(params[1]!)
  c.archivedAt = new Date().toISOString()
  emit('channel.archived', { orgId: st().orgId, channelId: c.id, archived: true })
  return { channel: toChannel(c) }
})
route('POST', `${C}/unarchive`, ({ params }) => {
  const c = channelOr404(params[1]!)
  delete c.archivedAt
  emit('channel.archived', { orgId: st().orgId, channelId: c.id, archived: false })
  return { channel: toChannel(c) }
})
route('POST', `${C}/read`, ({ params, body }) => {
  const c = channelOr404(params[1]!)
  const id = String(body.messageId ?? '')
  const current = c.lastRead.get(ME)
  if (id && (!current || id > current)) {
    c.lastRead.set(ME, id)
    emit('channel.read', { orgId: st().orgId, channelId: c.id, lastReadId: id })
  }
  return NO_CONTENT
})
route('POST', `${C}/typing`, () => NO_CONTENT)
route('GET', `${C}/members`, ({ params }) => ({
  members: [...channelOr404(params[1]!).members].map((id) => ({ user: person(id)!, joinedAt: st().people.get(id)!.joinedAt })),
}))
route('POST', `${C}/members`, ({ params, body }) => {
  const c = channelOr404(params[1]!)
  const before = c.members.size
  for (const id of (body.userIds as string[] | undefined) ?? []) if (st().people.has(id)) c.members.add(id)
  emit('channel.members', { orgId: st().orgId, channelId: c.id, memberCount: c.members.size })
  return { added: c.members.size - before }
})
route('DELETE', `${C}/members/:user`, ({ params }) => {
  const c = channelOr404(params[1]!)
  c.members.delete(params[2]!)
  emit('channel.members', { orgId: st().orgId, channelId: c.id, memberCount: c.members.size })
  return NO_CONTENT
})
route('GET', `${C}/files`, () => ({ files: [] }))
route('GET', `${C}/tasks`, () => ({ tasks: [] }))
route('POST', `${C}/files`, () => {
  throw demoOff()
})

route('GET', `${O}/conversations`, () => ({
  conversations: [...st().channels.values()]
    .filter((c) => c.kind === 'direct' && c.members.has(ME))
    .map((c) => toChannel(c, true))
    .sort((a, b) => (b.lastMessage?.id ?? b.createdAt).localeCompare(a.lastMessage?.id ?? a.createdAt)),
}))
route('POST', `${O}/conversations`, ({ body }) => {
  const ids = new Set([ME, ...((body.userIds as string[] | undefined) ?? []).filter((id) => st().people.has(id))])
  const existing = [...st().channels.values()].find(
    (c) => c.kind === 'direct' && c.members.size === ids.size && [...ids].every((id) => c.members.has(id)),
  )
  if (existing) return { conversation: toChannel(existing, true) }
  const rec: ChannelRec = {
    id: newId(),
    kind: 'direct',
    name: '',
    topic: '',
    visibility: 'private',
    isDefault: false,
    createdBy: ME,
    createdAt: new Date().toISOString(),
    members: ids,
    lastRead: new Map([...ids].map((m) => [m, null])),
  }
  st().channels.set(rec.id, rec)
  st().messages.set(rec.id, [])
  return { conversation: toChannel(rec, true) }
})

// Messages.
const PAGE = 50
route('GET', `${C}/messages`, ({ params, query }) => {
  const c = channelOr404(params[1]!)
  let list = topLevel(c.id)
  const before = query.get('before')
  if (before) list = list.filter((m) => m.id < before)
  const page = list.slice(-PAGE)
  return { messages: page.map((m) => toMessage(m)), hasMore: list.length > page.length }
})
route('POST', `${C}/messages`, ({ params, body }) => {
  const c = channelOr404(params[1]!)
  if (!c.members.has(ME)) throw new HttpError(403, 'forbidden', st().lang === 'tr' ? 'Önce kanala katılın.' : 'Join the channel first.')
  if (Array.isArray(body.attachmentIds) && body.attachmentIds.length) throw demoOff()
  const text = String(body.body ?? '').trim()
  if (!text) throw new HttpError(422, 'validation', st().lang === 'tr' ? 'Mesaj boş olamaz.' : 'The message cannot be empty.')
  const parentId = typeof body.parentId === 'string' ? body.parentId : undefined
  if (parentId) messageOr404(c.id, parentId)
  const rec = post(c, ME, text, parentId)
  scheduleReply(c, rec)
  return { message: toMessage(rec) }
})
route('GET', `${C}/messages/:message/replies`, ({ params }) => {
  const c = channelOr404(params[1]!)
  const root = messageOr404(c.id, params[2]!)
  return { root: toMessage(root), replies: repliesOf(root).map((m) => toMessage(m, false)) }
})
route('PATCH', `${C}/messages/:message`, ({ params, body }) => {
  const c = channelOr404(params[1]!)
  const m = messageOr404(c.id, params[2]!)
  if (m.authorId !== ME) throw demoOff()
  m.body = String(body.body ?? m.body)
  m.editedAt = new Date().toISOString()
  emit('message.updated', { orgId: st().orgId, channelId: c.id, message: toMessage(m) })
  return { message: toMessage(m) }
})
route('DELETE', `${C}/messages/:message`, ({ params }) => {
  const c = channelOr404(params[1]!)
  const m = messageOr404(c.id, params[2]!)
  if (m.authorId !== ME) throw demoOff()
  const list = messagesOf(c.id)
  if (!m.parentId && repliesOf(m).length) {
    m.deleted = true
    emit('message.updated', { orgId: st().orgId, channelId: c.id, message: toMessage(m) })
  } else {
    list.splice(list.indexOf(m), 1)
    emit('message.deleted', { orgId: st().orgId, channelId: c.id, messageId: m.id, parentId: m.parentId ?? null })
    if (m.parentId) {
      const root = list.find((x) => x.id === m.parentId)
      if (root) emit('message.updated', { orgId: st().orgId, channelId: c.id, message: toMessage(root) })
    }
  }
  return NO_CONTENT
})
route('POST', `${C}/messages/:message/reactions`, ({ params, body }) => react(params[1]!, params[2]!, String(body.emoji ?? ''), true))
route('DELETE', `${C}/messages/:message/reactions`, ({ params, query }) => react(params[1]!, params[2]!, query.get('emoji') ?? '', false))
route('PUT', `${C}/messages/:message/pin`, ({ params }) => pin(params[1]!, params[2]!, true))
route('DELETE', `${C}/messages/:message/pin`, ({ params }) => pin(params[1]!, params[2]!, false))
route('GET', `${C}/pins`, ({ params }) => ({
  messages: messagesOf(channelOr404(params[1]!).id)
    .filter((m) => m.pinned)
    .sort((a, b) => b.pinned!.at.localeCompare(a.pinned!.at))
    .map((m) => toMessage(m)),
}))

route('GET', `${O}/search`, ({ query }) => {
  const words = (query.get('q') ?? '').toLocaleLowerCase(st().lang).split(/\s+/).filter(Boolean)
  const channelId = query.get('channelId')
  const authorId = query.get('authorId')
  const limit = Number(query.get('limit')) || 50
  const results = []
  for (const c of st().channels.values()) {
    if (!c.members.has(ME) || (channelId && c.id !== channelId)) continue
    for (const m of messagesOf(c.id)) {
      if (m.deleted || (authorId && m.authorId !== authorId)) continue
      const tokens = m.body.toLocaleLowerCase(st().lang).split(/[^\p{L}\p{N}]+/u)
      if (words.length && words.every((w) => tokens.some((t) => t.startsWith(w)))) results.push({ message: toMessage(m), channel: toChannel(c) })
    }
  }
  results.sort((a, b) => b.message.id.localeCompare(a.message.id))
  return { results: results.slice(0, limit) }
})

// Not in this demo step: empty lists so the pages still open.
route('GET', `${O}/rooms`, () => ({ rooms: [] }))
route('GET', `${O}/meetings`, () => ({ meetings: [] }))
route('GET', `${O}/projects`, () => ({ projects: [] }))
route('GET', `${O}/boards`, () => ({ boards: [] }))
route('GET', `${O}/tasks`, () => ({ tasks: [] }))
route('GET', `${O}/audit-events`, () => ({ events: [], nextBefore: null }))
route('GET', `${O}/domains`, () => ({ domains: [] }))
route('GET', `${O}/access-keys`, () => ({ accessKeys: [] }))
route('GET', `${O}/invitations`, () => ({ invitations: [] }))
route('GET', `${O}/retention`, () => ({ days: null }))

// ------------------------------------------------------------------- behaviour

function post(c: ChannelRec, authorId: string, body: string, parentId?: string): MessageRec {
  const id = newId()
  const rec: MessageRec = {
    id,
    channelId: c.id,
    ...(parentId && { parentId }),
    authorId,
    body,
    createdAt: new Date(lastMs).toISOString(),
    reactions: [],
  }
  messagesOf(c.id).push(rec)
  if (authorId === ME && !parentId) c.lastRead.set(ME, rec.id)
  emit('message.created', { orgId: st().orgId, channelId: c.id, message: toMessage(rec) })
  if (parentId) {
    const root = messagesOf(c.id).find((m) => m.id === parentId)
    if (root) emit('message.updated', { orgId: st().orgId, channelId: c.id, message: toMessage(root) })
  }
  return rec
}

function react(channelId: string, messageId: string, emoji: string, add: boolean) {
  const c = channelOr404(channelId)
  const m = messageOr404(c.id, messageId)
  let r = m.reactions.find((x) => x.emoji === emoji)
  if (add && emoji) {
    if (!r) m.reactions.push((r = { emoji, userIds: [] }))
    if (!r.userIds.includes(ME)) r.userIds.push(ME)
  } else if (r) {
    r.userIds = r.userIds.filter((id) => id !== ME)
    if (!r.userIds.length) m.reactions.splice(m.reactions.indexOf(r), 1)
  }
  const reactions = reactionsOf(m)
  emit('message.reactions', { orgId: st().orgId, channelId: c.id, messageId: m.id, parentId: m.parentId ?? null, reactions })
  return { reactions }
}

function pin(channelId: string, messageId: string, on: boolean) {
  const c = channelOr404(channelId)
  const m = messageOr404(c.id, messageId)
  if (on) m.pinned = { at: new Date().toISOString(), by: ME }
  else delete m.pinned
  emit('message.updated', { orgId: st().orgId, channelId: c.id, message: toMessage(m) })
  return { message: toMessage(m) }
}

/** A teammate types for a moment and answers, so the demo feels alive. */
const pendingReply = new Set<string>()
function scheduleReply(c: ChannelRec, mine: MessageRec) {
  const key = `${c.id}:${mine.parentId ?? ''}`
  if (pendingReply.has(key)) return
  const candidates = [...c.members].filter((id) => id !== ME && st().people.get(id)?.presence !== 'offline')
  const responder = candidates[Math.floor(Math.random() * candidates.length)]
  if (!responder) return
  pendingReply.add(key)
  const parentId = mine.parentId ?? null
  const typing = () => emit('typing', { orgId: st().orgId, channelId: c.id, parentId, user: person(responder)! })
  setTimeout(typing, 900)
  setTimeout(typing, 2600)
  setTimeout(() => {
    pendingReply.delete(key)
    if (!st().channels.has(c.id)) return
    const text = replies[Math.floor(Math.random() * replies.length)]![st().lang]
    post(c, responder, text, mine.parentId)
  }, 3800)
}

// ---------------------------------------------------------------------- entry

/** Answers one /api/v1 request. */
export async function handle(method: string, path: string, query: URLSearchParams, body: unknown, language: string): Promise<Response> {
  if (!state) {
    state = seed(language.toLowerCase().startsWith('en') ? 'en' : 'tr')
    seedNotifications()
  }
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 80)) // a little network latency
  try {
    const found = routes.find((r) => r.method === method && r.pattern.test(path))
    if (!found) throw method === 'GET' ? notFound() : demoOff()
    const params = path.match(found.pattern)!.slice(1).map(decodeURIComponent)
    if (body instanceof FormData) throw demoOff()
    const result = found.handle({ params, query, body: (body ?? {}) as Body })
    if (result === NO_CONTENT) return new Response(null, { status: 204 })
    return Response.json(result)
  } catch (err) {
    if (err instanceof HttpError) return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status })
    console.error('[demo]', method, path, err)
    return Response.json({ error: { code: 'internal', message: 'Demo error.' } }, { status: 500 })
  }
}
