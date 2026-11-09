import type { Channel, LiveEvents, Task } from '@fudislte/api-client'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { api, queryKeys } from '../../lib/api'
import {
  addMessage,
  bumpConversation,
  isChannelVisible,
  isListed,
  isRoom,
  markReadLocally,
  removeMessage,
  replaceMessage,
  setReactions,
  updateChannel,
  updateRoom,
} from './cache'
import { emitBoardEvent } from '../boards/live'
import { addNotification, notificationTitle } from '../notifications/NotificationBell'
import { applyTask, removeTask } from '../projects/cache'
import { showDesktop } from '../notifications/desktop'
import { applyPresence, trackActivity } from '../presence/presence'
import { messagePreview } from './text'
import { noteTyping, stopTyping } from './typing'
import { leaveVoiceIfIn } from '../voice/voice'

const MAX_RETRY_MS = 30_000

/**
 * Keeps one live event stream open for the signed-in user (docs/decisions/0008) and
 * applies its events to the query cache. Events are hints, not the source of truth:
 * after any reconnect, chat data is refetched.
 */
export function useLiveEvents(userId: string) {
  const qc = useQueryClient()

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let source: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryMs = 1_000
    let connectedBefore = false
    let stopped = false
    let connectionId: string | null = null

    // Presence: this window reports when it goes idle or hidden, and when it is back.
    const report = (active: boolean) => {
      if (connectionId) api.reportActivity(connectionId, active).catch(() => {})
    }
    const activity = trackActivity(report)

    const connect = () => {
      source = new EventSource(api.eventsUrl())
      source.addEventListener('ready', (e) => {
        retryMs = 1_000
        try {
          connectionId = (JSON.parse((e as MessageEvent<string>).data) as LiveEvents['ready']).connectionId
        } catch {
          connectionId = null
        }
        if (!activity.active()) report(false) // new streams start out active
        if (connectedBefore) resync(qc) // events may have been missed while disconnected
        connectedBefore = true
      })
      // The browser retries dropped connections itself, but gives up after an HTTP error
      // (for example while the server restarts); then we retry with backoff.
      source.addEventListener('error', () => {
        if (source?.readyState !== EventSource.CLOSED || stopped) return
        source.close()
        retryTimer = setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
      })
      const on = <K extends keyof LiveEvents>(type: K, handle: (data: LiveEvents[K]) => void) =>
        source?.addEventListener(type, (e) => {
          try {
            handle(JSON.parse((e as MessageEvent<string>).data) as LiveEvents[K])
          } catch {
            // A malformed event is ignored; the next refetch corrects the view.
          }
        })

      on('message.created', ({ orgId, message }) => {
        addMessage(qc, orgId, message)
        if (message.author) stopTyping(message.channelId, message.parentId, message.author.id)
        if (message.parentId) return // replies update their thread; the root arrives as message.updated
        if (isRoom(qc, orgId, message.channelId)) {
          if (message.author?.id === userId) markReadLocally(qc, orgId, message.channelId, message.id)
          else if (!isChannelVisible(message.channelId))
            updateRoom(qc, orgId, message.channelId, (r) => ({ ...r, unreadCount: Math.min(r.unreadCount + 1, 100) }))
          return
        }
        bumpConversation(qc, orgId, message)
        const conversation = qc.getQueryData<Channel[]>(queryKeys.conversations(orgId))?.find((c) => c.id === message.channelId)
        if (conversation && message.author && message.author.id !== userId && !isChannelVisible(message.channelId)) {
          showDesktop(qc, {
            kind: 'message',
            title: message.author.displayName,
            body: messagePreview(message),
            tag: message.id,
            orgId,
            channelId: message.channelId,
          })
        }
        // A conversation someone else just started: fetch it with its unread count.
        if (!isListed(qc, orgId, message.channelId)) {
          void qc.invalidateQueries({ queryKey: queryKeys.conversations(orgId) })
          return
        }
        if (message.author?.id === userId) {
          markReadLocally(qc, orgId, message.channelId, message.id)
        } else if (!isChannelVisible(message.channelId)) {
          updateChannel(qc, orgId, message.channelId, (c) => ({ ...c, unreadCount: Math.min(c.unreadCount + 1, 100) }))
        }
      })
      on('message.updated', ({ orgId, message }) => {
        replaceMessage(qc, orgId, message)
        void qc.invalidateQueries({ queryKey: queryKeys.pins(orgId, message.channelId) }) // pinned or unpinned
      })
      on('message.reactions', ({ orgId, channelId, messageId, reactions }) =>
        setReactions(qc, orgId, channelId, messageId, reactions),
      )
      on('message.deleted', ({ orgId, channelId, messageId, parentId }) => {
        removeMessage(qc, orgId, channelId, messageId)
        if (!parentId) qc.removeQueries({ queryKey: queryKeys.thread(orgId, channelId, messageId) })
        void qc.invalidateQueries({ queryKey: queryKeys.pins(orgId, channelId) })
        // Unread counts and conversation previews may change.
        void qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.conversations(orgId) })
      })
      on('channel.updated', ({ orgId, channelId, name, topic }) =>
        updateChannel(qc, orgId, channelId, (c) => ({ ...c, name, topic })),
      )
      on('channel.read', ({ orgId, channelId, lastReadId }) => markReadLocally(qc, orgId, channelId, lastReadId))
      on('channel.joined', ({ orgId, channelId }) => {
        void qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.conversations(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.rooms(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.room(orgId, channelId) })
      })
      on('voice.updated', ({ orgId, roomId, meetingId, participants }) => {
        if (meetingId) qc.setQueryData(queryKeys.meetingVoice(orgId, meetingId), { enabled: true, participants })
        else if (roomId) qc.setQueryData(queryKeys.voice(orgId, roomId), { enabled: true, participants })
      })
      on('room.updated', ({ orgId, roomId }) => {
        void qc.invalidateQueries({ queryKey: queryKeys.rooms(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.room(orgId, roomId) })
      })
      // A meeting was scheduled, changed or canceled, or the caller was taken off its list.
      on('meeting.updated', ({ orgId, meetingId }) => {
        void qc.invalidateQueries({ queryKey: queryKeys.meetings(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.meeting(orgId, meetingId) })
      })
      // Projects and tasks: the event carries the task as everyone who may see it sees it.
      on('task.updated', ({ orgId, task }) => {
        applyTask(qc, orgId, task)
        void qc.invalidateQueries({ queryKey: queryKeys.task(orgId, task.id) })
        void qc.invalidateQueries({ queryKey: queryKeys.projectActivity(orgId, task.project.id) })
        // My tasks change only with tasks assigned to me now or before.
        const mine = qc.getQueryData<Task[]>(queryKeys.myTasks(orgId))
        if (task.assignees.some((p) => p.id === userId) || mine?.some((x) => x.id === task.id)) {
          void qc.invalidateQueries({ queryKey: queryKeys.myTasks(orgId) })
        }
      })
      on('task.deleted', ({ orgId, projectId, taskId }) => {
        removeTask(qc, orgId, projectId, taskId)
        void qc.invalidateQueries({ queryKey: queryKeys.myTasks(orgId) })
      })
      // Settings, workflow, members or sprints changed — or the caller lost access.
      on('project.updated', ({ orgId, projectId }) => {
        void qc.invalidateQueries({ queryKey: queryKeys.project(orgId, projectId) })
        void qc.invalidateQueries({ queryKey: queryKeys.projectTasks(orgId, projectId) })
        void qc.invalidateQueries({ queryKey: queryKeys.projectActivity(orgId, projectId) })
        void qc.invalidateQueries({ queryKey: queryKeys.projects(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.myTasks(orgId) })
      })
      on('channel.tasks', ({ orgId, channelId }) => void qc.invalidateQueries({ queryKey: queryKeys.channelTasks(orgId, channelId) }))
      // Whiteboards: the open board applies them itself.
      on('board.elements', (data) => emitBoardEvent({ type: 'board.elements', data }))
      on('board.cursor', (data) => emitBoardEvent({ type: 'board.cursor', data }))
      on('board.viewers', (data) => emitBoardEvent({ type: 'board.viewers', data }))
      on('board.updated', (data) => {
        emitBoardEvent({ type: 'board.updated', data })
        void qc.invalidateQueries({ queryKey: queryKeys.boards(data.orgId) })
      })
      on('board.deleted', (data) => {
        emitBoardEvent({ type: 'board.deleted', data })
        void qc.invalidateQueries({ queryKey: queryKeys.boards(data.orgId) })
      })
      on('channel.archived', ({ orgId, channelId }) => {
        void qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.channel(orgId, channelId) })
        void qc.invalidateQueries({ queryKey: queryKeys.browseChannels(orgId) })
      })
      on('channel.members', ({ orgId, channelId, memberCount }) => {
        updateChannel(qc, orgId, channelId, (c) => ({ ...c, memberCount }))
        void qc.invalidateQueries({ queryKey: queryKeys.channelMembers(orgId, channelId) })
        void qc.invalidateQueries({ queryKey: queryKeys.roomMembers(orgId, channelId) })
        updateRoom(qc, orgId, channelId, (r) => ({ ...r, memberCount }))
      })
      on('presence.changed', (entry) => {
        applyPresence(qc, entry)
        if (entry.userId === userId) void qc.invalidateQueries({ queryKey: queryKeys.me }) // own status, mute included
      })
      on('typing', ({ channelId, parentId, user }) => noteTyping(channelId, parentId, user))
      on('notification.created', ({ orgId, notification }) => {
        addNotification(qc, orgId, notification)
        const visible = isChannelVisible(notification.channelId) && !notification.message.parentId
        if (!visible) {
          showDesktop(qc, {
            kind: notification.kind,
            title: notificationTitle(notification),
            body: messagePreview(notification.message),
            tag: notification.message.id,
            orgId,
            channelId: notification.channelId,
            threadId: notification.message.parentId,
          })
        }
      })
      on('notification.read', ({ orgId }) => void qc.invalidateQueries({ queryKey: queryKeys.notifications(orgId) }))
      on('channel.left', ({ orgId, channelId }) => {
        void qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.channel(orgId, channelId) })
        // A room admission that ended (expired, revoked or a new password): lock it again.
        void qc.invalidateQueries({ queryKey: queryKeys.rooms(orgId) })
        void qc.invalidateQueries({ queryKey: queryKeys.room(orgId, channelId) })
        qc.removeQueries({ queryKey: queryKeys.messages(orgId, channelId) })
        leaveVoiceIfIn('room', channelId)
        void qc.invalidateQueries({ queryKey: queryKeys.browseChannels(orgId) })
      })
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(retryTimer)
      activity.stop()
      source?.close()
    }
  }, [qc, userId])
}

const resyncedLists = [
  'channels',
  'conversations',
  'channel',
  'messages',
  'thread',
  'pins',
  'presence',
  'notifications',
  'rooms',
  'room',
  'meetings',
  'meeting',
  'projects',
  'project',
  'project-tasks',
  'project-activity',
  'task',
  'my-tasks',
  'channel-tasks',
  'boards',
]

function resync(qc: QueryClient) {
  void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'orgs' && resyncedLists.includes(String(q.queryKey[2])) })
  // An open board merges the stored scene instead of reloading.
  emitBoardEvent({ type: 'resync' })
}
