import type { Channel, Message } from '@fudislte/api-client'
import {
  Alert,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from '@fudislte/ui'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  FolderIcon,
  LogOutIcon,
  MessageSquareIcon,
  PencilIcon,
  UsersIcon,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useShell, useWorkspace } from '../../shell/context'
import { addMessage, markReadLocally, patchMessage, removeMessage, setVisibleChannel } from './cache'
import { ChannelMembersDialog, ConfirmDialog, EditChannelDialog, useCanManageChannel } from './ChannelDialogs'
import { ChannelFiles } from './ChannelFiles'
import { ChannelIcon, useChannels } from './ChannelSidebar'
import { Composer } from './Composer'
import { ConversationAvatar, useConversations } from './DirectMessages'
import { type MessageActions, MessageList } from './MessageList'
import { channelTitle, otherParticipants } from './names'
import { PinnedBar } from './PinnedBar'
import { isNewer } from './text'
import { ThreadPanel } from './ThreadPanel'

/**
 * /w/:slug/c/:channelId — a joined channel, a public one to preview, or a direct
 * conversation. Listed ones come from the live-updated sidebar caches.
 */
export function ChannelPage() {
  const t = useT()
  const { channelId = '' } = useParams()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const channels = useChannels()
  const conversations = useConversations()
  const listed = channels.data?.find((c) => c.id === channelId) ?? conversations.data?.find((c) => c.id === channelId)
  const loadingLists = channels.isPending || conversations.isPending
  const detail = useQuery({
    queryKey: queryKeys.channel(orgId, channelId),
    queryFn: () => api.channel(orgId, channelId),
    enabled: !loadingLists && !listed,
  })
  const channel = listed ?? detail.data
  const location = useLocation()

  if (channel?.kind === 'room') {
    // Links from search, notifications and desktop notices name the channel; rooms have their own page.
    return <Navigate to={`/w/${workspace.organization.slug}/r/${channel.id}${location.search}`} replace />
  }
  if (!channel) {
    if (loadingLists || detail.isFetching) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Spinner label={t('chat.loading')} />
        </div>
      )
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-[14px] text-muted-foreground">{t('chat.notFound')}</p>
        <Button variant="outline" asChild>
          <Link to={`/w/${workspace.organization.slug}`}>{t('chat.backHome')}</Link>
        </Button>
      </div>
    )
  }
  return <Conversation key={channel.id} channel={channel} />
}

function useDocumentVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

/**
 * The conversation view shared by channels, direct conversations and rooms. Rooms pass
 * their own header.
 */
export function Conversation({ channel, header }: { channel: Channel; header?: ReactNode }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const visible = useDocumentVisible()
  const direct = channel.kind === 'direct'
  const title = channelTitle(channel, me.user.id, t)
  const others = otherParticipants(channel, me.user.id)
  const canManageChannel = useCanManageChannel(channel)
  const canManage = channel.kind === 'channel' && canManageChannel
  const [unreadAfter] = useState(channel.joined ? channel.lastReadId : undefined)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'members' | 'edit' | 'leave' | 'archive' | null>(null)
  const [deleting, setDeleting] = useState<Message | null>(null)

  useEffect(() => {
    setVisibleChannel(channel.id)
    return () => setVisibleChannel(null)
  }, [channel.id])

  const history = useInfiniteQuery({
    queryKey: queryKeys.messages(orgId, channel.id),
    queryFn: ({ pageParam }) => api.messages(orgId, channel.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.hasMore ? page.messages[0]?.id : undefined),
    staleTime: Infinity, // live events keep it current; reconnects refetch
  })
  const messages = useMemo(
    () => (history.data ? [...history.data.pages].reverse().flatMap((p) => p.messages) : []),
    [history.data],
  )
  const newest = messages[messages.length - 1]

  // Reading the newest message while the tab is visible marks the channel as read.
  useEffect(() => {
    if (!channel.joined || !newest || !visible || !isNewer(newest.id, channel.lastReadId)) return
    markReadLocally(qc, orgId, channel.id, newest.id)
    api.markChannelRead(orgId, channel.id, newest.id).catch(() => {
      // Not critical: the unread count corrects itself on the next refetch.
    })
  }, [channel.joined, channel.lastReadId, channel.id, newest, visible, orgId, qc])

  const send = useMutation({
    mutationFn: ({ body, attachmentIds }: { body: string; attachmentIds: string[] }) =>
      api.sendMessage(orgId, channel.id, body, undefined, attachmentIds),
    onSuccess: (message) => {
      addMessage(qc, orgId, message)
      markReadLocally(qc, orgId, channel.id, message.id)
      if (message.attachments?.length) void qc.invalidateQueries({ queryKey: queryKeys.files(orgId, channel.id) })
    },
  })
  const archived = !!channel.archivedAt
  const archive = useMutation({
    mutationFn: () => (archived ? api.unarchiveChannel(orgId, channel.id) : api.archiveChannel(orgId, channel.id)),
    onSuccess: async (updated) => {
      qc.setQueryData(queryKeys.channel(orgId, channel.id), updated)
      await qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
      void qc.invalidateQueries({ queryKey: queryKeys.browseChannels(orgId) })
      setDialog(null)
    },
  })
  const join = useMutation({
    mutationFn: () => api.joinChannel(orgId, channel.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) }),
  })
  const leave = useMutation({
    mutationFn: () => api.leaveChannel(orgId, channel.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
      setDialog(null)
      navigate(`/w/${workspace.organization.slug}`)
    },
  })
  const remove = useMutation({
    mutationFn: (m: Message) => api.deleteMessage(orgId, channel.id, m.id),
    onSuccess: (_, m) => {
      if (m.thread) {
        // A root with replies stays as a placeholder so its thread survives.
        patchMessage(qc, orgId, channel.id, m.id, (x) => ({
          ...x,
          body: '',
          deleted: true,
          mentions: [],
          reactions: [],
          pinned: undefined,
        }))
      } else {
        removeMessage(qc, orgId, channel.id, m.id)
      }
      setDeleting(null)
    },
  })

  const editLast = useCallback(() => {
    const last = [...messages].reverse().find((m) => m.author?.id === me.user.id)
    if (last && channel.joined) setEditingId(last.id)
  }, [messages, me.user.id, channel.joined])
  const canDelete = useCallback(
    (m: Message) => !archived && (m.author?.id === me.user.id || (!direct && can(workspace, 'messages.manage'))),
    [me.user.id, workspace, direct, archived],
  )

  const leaveChannel = () => (channel.visibility === 'private' ? setDialog('leave') : leave.mutate())

  // Threads open beside the conversation; the URL (?thread=) makes them linkable.
  const [searchParams, setSearchParams] = useSearchParams()
  const threadId = searchParams.get('thread')
  const { setAsideTaken } = useShell()
  useEffect(() => {
    setAsideTaken(threadId !== null)
    return () => setAsideTaken(false)
  }, [threadId, setAsideTaken])
  const openThread = useCallback(
    (rootId: string) =>
      setSearchParams((p) => {
        p.set('thread', rootId)
        return p
      }),
    [setSearchParams],
  )
  const closeThread = () =>
    setSearchParams((p) => {
      p.delete('thread')
      return p
    })

  // People who can be mentioned: the channel's members, or a conversation's participants.
  const members = useQuery({
    queryKey: queryKeys.channelMembers(orgId, channel.id),
    queryFn: () => api.channelMembers(orgId, channel.id),
    enabled: channel.joined && !direct,
  })
  const people = useMemo(
    () => (direct ? (channel.participants ?? []) : (members.data?.map((m) => m.user) ?? [])),
    [direct, channel.participants, members.data],
  )

  // ?message= (from search) scrolls to a message once; ?tab=files shows the files.
  const [focusId, setFocusId] = useState<string | null>(null)
  const messageParam = searchParams.get('message')
  useEffect(() => {
    if (messageParam) setFocusId(messageParam)
  }, [messageParam])
  const onFocused = useCallback(() => {
    setFocusId(null)
    setSearchParams(
      (p) => {
        p.delete('message')
        return p
      },
      { replace: true },
    )
  }, [setSearchParams])
  const tab = searchParams.get('tab') === 'files' ? 'files' : 'chat'
  const setTab = (next: 'chat' | 'files') =>
    setSearchParams((p) => {
      if (next === 'files') p.set('tab', 'files')
      else p.delete('tab')
      return p
    })
  const jumpTo = (m: Message) => (m.parentId ? openThread(m.parentId) : setFocusId(m.id))
  // fetchNextPage is stable; the query result object is new on every render.
  const { fetchNextPage } = history
  const loadOlder = useCallback(() => void fetchNextPage(), [fetchNextPage])
  const openThreadOf = useCallback((root: Message) => openThread(root.id), [openThread])

  const actions = useMemo<MessageActions>(
    () => ({
      orgId,
      channel,
      meId: me.user.id,
      editingId,
      onEditingChange: setEditingId,
      canDelete,
      onDelete: setDeleting,
      onOpenThread: openThreadOf,
    }),
    [orgId, channel, me.user.id, editingId, canDelete, openThreadOf],
  )

  return (
    <div className="flex min-h-0 flex-1">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header ?? (
      <header className="flex shrink-0 items-start gap-3 border-b px-6 pt-5 pb-4">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2.5 text-xl font-bold tracking-tight">
            {direct ? (
              <ConversationAvatar conversation={channel} size="sm" />
            ) : (
              <ChannelIcon channel={channel} className="size-5 text-muted-foreground" />
            )}
            <span className="truncate">{title}</span>
          </h1>
          {channel.topic && <p className="mt-1 truncate text-[13px] text-muted-foreground">{channel.topic}</p>}
        </div>
        {(!direct || others.length > 1) && (
          <Tooltip content={t(direct ? 'dm.participants' : 'chat.membersButton')} side="bottom">
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setDialog('members')}
              aria-label={t(direct ? 'dm.participants' : 'chat.membersButton')}
            >
              <UsersIcon />
              {channel.memberCount}
            </Button>
          </Tooltip>
        )}
        {(canManage || (!direct && channel.joined && !channel.isDefault)) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-9" aria-label={t('chat.options')}>
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canManage && !archived && (
                <DropdownMenuItem onSelect={() => setDialog('edit')}>
                  <PencilIcon />
                  {t('chat.edit')}
                </DropdownMenuItem>
              )}
              {canManage && !channel.isDefault && (
                <DropdownMenuItem onSelect={() => (archived ? archive.mutate() : setDialog('archive'))}>
                  {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {archived ? t('archive.restore') : t('archive.archive')}
                </DropdownMenuItem>
              )}
              {!direct && channel.joined && !channel.isDefault && (
                <DropdownMenuItem onSelect={leaveChannel} className="text-destructive focus:text-destructive">
                  <LogOutIcon />
                  {t('chat.leave')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      )}
      <nav aria-label={t('files.tabs')} className="flex shrink-0 gap-1 border-b px-6">
        {(['chat', 'files'] as const).map((key) => (
          <button
            key={key}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:text-foreground',
              tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {key === 'chat' ? <MessageSquareIcon className="size-4" /> : <FolderIcon className="size-4" />}
            {key === 'chat' ? t('files.chatTab') : t('files.filesTab')}
          </button>
        ))}
      </nav>
      {archived && (
        <div className="mx-6 mt-3 flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
          <ArchiveIcon className="size-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <p className="flex-1 text-[13px] text-amber-900 dark:text-amber-200">{t('archive.banner')}</p>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => archive.mutate()} disabled={archive.isPending}>
              {t('archive.restore')}
            </Button>
          )}
        </div>
      )}
      {tab === 'files' ? (
        <ChannelFiles orgId={orgId} channel={channel} />
      ) : (
        <>
      <PinnedBar orgId={orgId} channel={channel} onJump={jumpTo} />

      {history.isPending ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner label={t('chat.loading')} />
        </div>
      ) : history.error ? (
        <div className="p-6">
          <Alert variant="error">{errorMessage(history.error)}</Alert>
        </div>
      ) : (
        <MessageList
          messages={messages}
          actions={actions}
          hasOlder={history.hasNextPage}
          loadingOlder={history.isFetchingNextPage}
          loadOlder={loadOlder}
          unreadAfter={unreadAfter}
          focusId={focusId}
          onFocused={onFocused}
        />
      )}

      {(send.error || leave.error || join.error || archive.error) && (
        <div className="px-6 pb-2">
          <Alert variant="error">{errorMessage(send.error ?? leave.error ?? join.error ?? archive.error)}</Alert>
        </div>
      )}
      {archived ? null : channel.joined ? (
        <Composer
          draftKey={channel.id}
          people={people}
          typingIn={{ channelId: channel.id }}
          onTyping={() => void api.typing(orgId, channel.id).catch(() => {})}
          onUpload={(file) => api.uploadFile(orgId, channel.id, file, file.name)}
          onDiscard={(id) => void api.deleteUpload(orgId, id).catch(() => {})}
          placeholder={
            channel.kind === 'room'
              ? t('rooms.placeholder', { name: channel.name })
              : !direct
              ? t('chat.placeholder', { name: channel.name })
              : others.length === 0
                ? t('dm.noteToSelf')
                : others.length === 1
                  ? t('dm.placeholder', { name: title })
                  : t('dm.groupPlaceholder')
          }
          onSend={(body, attachmentIds) => send.mutateAsync({ body, attachmentIds })}
          onEditLast={editLast}
        />
      ) : (
        <div className="m-6 mt-1 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/50 px-4 py-3">
          <p className="text-[13px] text-muted-foreground">{t('chat.preview', { name: channel.name })}</p>
          <Button onClick={() => join.mutate()} disabled={join.isPending}>
            {t('chat.join')}
          </Button>
        </div>
      )}
        </>
      )}
      <ConfirmDialog
        open={dialog === 'archive'}
        title={t('archive.title', { name: channel.name })}
        text={t('archive.text')}
        action={t('archive.archive')}
        pending={archive.isPending}
        error={archive.error}
        onConfirm={() => archive.mutate()}
        onOpenChange={(o) => setDialog(o ? 'archive' : null)}
      />

      <ChannelMembersDialog channel={channel} open={dialog === 'members'} onOpenChange={(o) => setDialog(o ? 'members' : null)} />
      {canManage && <EditChannelDialog channel={channel} open={dialog === 'edit'} onOpenChange={(o) => setDialog(o ? 'edit' : null)} />}
      <ConfirmDialog
        open={dialog === 'leave'}
        title={t('chat.leaveTitle', { name: channel.name })}
        text={t('chat.leavePrivateText')}
        action={t('chat.leave')}
        pending={leave.isPending}
        error={leave.error}
        onConfirm={() => leave.mutate()}
        onOpenChange={(o) => setDialog(o ? 'leave' : null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={t('chat.deleteTitle')}
        text={t('chat.deleteText')}
        action={t('chat.delete')}
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null)
            remove.reset()
          }
        }}
      />
    </div>
      {threadId && (
        <ThreadPanel key={threadId} channel={channel} rootId={threadId} actions={actions} people={people} onClose={closeThread} />
      )}
    </div>
  )
}
