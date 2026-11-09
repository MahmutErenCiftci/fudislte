import type { Channel, Message, MessagePage, Reaction, Room, Thread } from '@fudislte/api-client'
import type { InfiniteData, QueryClient } from '@tanstack/react-query'

import { queryKeys } from '../../lib/api'
import { isNewer } from './text'

// Helpers that keep TanStack Query's chat caches in step with what the user does and
// with live events, so the UI never waits for a refetch.

export type MessagePages = InfiniteData<MessagePage, string | undefined>

/** Adds a message where it belongs — a channel's history or an open thread — once. */
export function addMessage(qc: QueryClient, orgId: string, message: Message) {
  if (message.parentId) {
    qc.setQueryData<Thread>(queryKeys.thread(orgId, message.channelId, message.parentId), (thread) =>
      !thread || thread.replies.some((m) => m.id === message.id) ? thread : { ...thread, replies: [...thread.replies, message] },
    )
    return
  }
  qc.setQueryData<MessagePages>(queryKeys.messages(orgId, message.channelId), (data) => {
    if (!data || data.pages.some((p) => p.messages.some((m) => m.id === message.id))) return data
    const [newest, ...older] = data.pages
    if (!newest) return data
    return { ...data, pages: [{ ...newest, messages: [...newest.messages, message] }, ...older] }
  })
}

/**
 * Applies change to one message wherever a channel's caches hold it: history (including
 * the latest reply shown under a root), open threads and pins. Returning null removes it.
 */
export function patchMessage(
  qc: QueryClient,
  orgId: string,
  channelId: string,
  messageId: string,
  change: (m: Message) => Message | null,
) {
  const apply = (m: Message): Message | null => {
    if (m.id === messageId) return change(m)
    if (m.thread?.latest.id === messageId) {
      const latest = change(m.thread.latest)
      return latest ? { ...m, thread: { ...m.thread, latest } } : m
    }
    return m
  }
  const applyAll = (list: Message[]) => list.map(apply).filter((m): m is Message => m !== null)
  qc.setQueryData<MessagePages>(queryKeys.messages(orgId, channelId), (data) =>
    data && { ...data, pages: data.pages.map((p) => ({ ...p, messages: applyAll(p.messages) })) },
  )
  qc.setQueriesData<Thread>({ queryKey: queryKeys.threads(orgId, channelId) }, (thread) => {
    if (!thread) return thread
    const root = apply(thread.root)
    return root ? { root, replies: applyAll(thread.replies) } : thread // a removed root closes its panel
  })
  qc.setQueryData<Message[]>(queryKeys.pins(orgId, channelId), (pins) => pins && applyAll(pins))
}

export function replaceMessage(qc: QueryClient, orgId: string, message: Message) {
  patchMessage(qc, orgId, message.channelId, message.id, () => message)
}

export function removeMessage(qc: QueryClient, orgId: string, channelId: string, messageId: string) {
  patchMessage(qc, orgId, channelId, messageId, () => null)
}

export function setReactions(qc: QueryClient, orgId: string, channelId: string, messageId: string, reactions: Reaction[]) {
  patchMessage(qc, orgId, channelId, messageId, (m) => ({ ...m, reactions }))
}

/** Applies update to the channel or conversation wherever it is cached. */
export function updateChannel(qc: QueryClient, orgId: string, channelId: string, update: (c: Channel) => Channel) {
  const inList = (list: Channel[] | undefined) => list?.map((c) => (c.id === channelId ? update(c) : c))
  qc.setQueryData<Channel[]>(queryKeys.channels(orgId), inList)
  qc.setQueryData<Channel[]>(queryKeys.conversations(orgId), inList)
  qc.setQueryData<Channel>(queryKeys.channel(orgId, channelId), (c) => c && update(c))
}

/** Whether the channel or conversation is in one of the sidebar lists. */
export function isListed(qc: QueryClient, orgId: string, channelId: string): boolean {
  return [queryKeys.channels(orgId), queryKeys.conversations(orgId)].some((key) =>
    qc.getQueryData<Channel[]>(key)?.some((c) => c.id === channelId),
  )
}

/** Makes message the conversation's latest and moves the conversation to the top. */
export function bumpConversation(qc: QueryClient, orgId: string, message: Message) {
  qc.setQueryData<Channel[]>(queryKeys.conversations(orgId), (list) => {
    const conv = list?.find((c) => c.id === message.channelId)
    if (!list || !conv) return list
    return [{ ...conv, lastMessage: message }, ...list.filter((c) => c !== conv)]
  })
}

/** Moves the read marker forward (never back) and clears the unread count. */
export function markReadLocally(qc: QueryClient, orgId: string, channelId: string, messageId: string) {
  const read = <T extends { lastReadId: string | null; unreadCount: number }>(c: T): T =>
    isNewer(messageId, c.lastReadId) ? { ...c, lastReadId: messageId, unreadCount: 0 } : c
  updateChannel(qc, orgId, channelId, read)
  updateRoom(qc, orgId, channelId, read)
}

/** Applies update to the room in the rooms list and its own cache entry. */
export function updateRoom(qc: QueryClient, orgId: string, roomId: string, update: (r: Room) => Room) {
  qc.setQueryData<Room[]>(queryKeys.rooms(orgId), (list) => list?.map((r) => (r.id === roomId ? update(r) : r)))
  qc.setQueryData<Room>(queryKeys.room(orgId, roomId), (r) => r && update(r))
}

export function isRoom(qc: QueryClient, orgId: string, channelId: string): boolean {
  return !!qc.getQueryData<Room[]>(queryKeys.rooms(orgId))?.some((r) => r.id === channelId)
}

/** The channel shown on screen, so live messages for it are not counted as unread. */
let visibleChannel: string | null = null

export function setVisibleChannel(channelId: string | null) {
  visibleChannel = channelId
}

export function isChannelVisible(channelId: string): boolean {
  return visibleChannel === channelId && document.visibilityState === 'visible'
}
