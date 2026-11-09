import type { Channel, Message } from '@fudislte/api-client'
import { Avatar, Button, cn, Spinner, Tooltip } from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquareReplyIcon, PencilIcon, PinIcon, PinOffIcon, SmilePlusIcon, Trash2Icon } from 'lucide-react'
import { type KeyboardEvent, memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime, formatDay, formatRelative, formatTime } from '../../lib/format'
import { replaceMessage } from './cache'
import { ChannelIcon } from './ChannelSidebar'
import { ConversationAvatar } from './DirectMessages'
import { MessageText } from './MessageText'
import { channelTitle, otherParticipants } from './names'
import { EmojiPicker, quickEmojis, ReactionBar, useToggleReaction } from './Reactions'
import { MessageAttachments } from './Attachments'
import { arrangeMessages, fromMentionTokens, isNewer, messagePreview, toMentionTokens } from './text'

/** What a message row needs from its page: who is reading and what they may do. */
export interface MessageActions {
  orgId: string
  channel: Channel
  meId: string
  editingId: string | null
  onEditingChange: (id: string | null) => void
  canDelete: (m: Message) => boolean
  onDelete: (m: Message) => void
  /** Opens a top-level message's thread; absent inside the thread panel. */
  onOpenThread?: (root: Message) => void
}

interface MessageListProps {
  messages: Message[]
  actions: MessageActions
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder: () => void
  /**
   * Read marker when the channel was opened; later messages get a "new" divider. Null
   * means nothing was read yet; undefined (previewing a channel) shows no divider.
   */
  unreadAfter: string | null | undefined
  /** A message to scroll to and highlight; older pages load until it appears. */
  focusId?: string | null
  onFocused?: (found: boolean) => void
}

const NEAR_BOTTOM_PX = 120
const LOAD_OLDER_PX = 400

/**
 * The conversation: day separators, author runs, a "new messages" divider and inline
 * editing. Keeps the view pinned to the newest message while the reader is at the
 * bottom, and keeps their place when older pages load above.
 */
export function MessageList({ messages, actions, hasOlder, loadingOlder, loadOlder, unreadAfter, focusId, onFocused }: MessageListProps) {
  const { channel, meId } = actions
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const divider = useRef<HTMLDivElement>(null)
  const prev = useRef<{ first?: string; last?: string; height: number; top: number; atBottom: boolean } | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const rows = useMemo(() => arrangeMessages(messages), [messages])
  const firstUnread =
    unreadAfter === undefined ? undefined : messages.find((m) => isNewer(m.id, unreadAfter) && m.author?.id !== meId)?.id
  const first = messages[0]?.id
  const last = messages[messages.length - 1]?.id

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const before = prev.current
    if (!before) {
      // First render: show the first unread message, or the newest one.
      if (divider.current) divider.current.scrollIntoView({ block: 'center' })
      else el.scrollTop = el.scrollHeight
    } else if (before.first !== first && before.last === last) {
      el.scrollTop = before.top + (el.scrollHeight - before.height) // older page above
    } else if (before.last !== last) {
      const mine = messages[messages.length - 1]?.author?.id === meId
      if (before.atBottom || mine) el.scrollTop = el.scrollHeight
    }
    prev.current = { first, last, height: el.scrollHeight, top: el.scrollTop, atBottom: isAtBottom(el) }
    if (el.scrollHeight <= el.clientHeight && hasOlder && !loadingOlder) loadOlder()
  }, [first, last, messages, meId, hasOlder, loadingOlder, loadOlder])

  // Image previews load after layout; keep a reader at the bottom pinned there.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onLoad = () => {
      if (prev.current?.atBottom) el.scrollTop = el.scrollHeight
    }
    el.addEventListener('load', onLoad, true) // load does not bubble; capture it
    return () => el.removeEventListener('load', onLoad, true)
  }, [])

  // Jump to a message (from a pin): load older pages until it is there.
  useEffect(() => {
    if (!focusId) return
    const target = scroller.current?.querySelector(`[data-message-id="${focusId}"]`)
    if (target) {
      // Instant: smooth scrolling stalls in throttled or background views.
      target.scrollIntoView({ block: 'center' })
      setFlashId(focusId)
      onFocused?.(true)
      const timer = setTimeout(() => setFlashId(null), 2000)
      return () => clearTimeout(timer)
    }
    if (hasOlder && !loadingOlder) loadOlder()
    else if (!hasOlder) onFocused?.(false)
  }, [focusId, messages, hasOlder, loadingOlder, loadOlder, onFocused])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    if (prev.current) prev.current = { ...prev.current, top: el.scrollTop, height: el.scrollHeight, atBottom: isAtBottom(el) }
    if (el.scrollTop < LOAD_OLDER_PX && hasOlder && !loadingOlder) loadOlder()
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto pb-2" aria-live="polite" aria-relevant="additions">
      {loadingOlder && (
        <div className="flex justify-center py-3">
          <Spinner label={t('chat.loadingOlder')} />
        </div>
      )}
      {!hasOlder && <ChannelWelcome channel={channel} meId={meId} />}
      {rows.map(({ message, newDay, continued }) => (
        // Rows off screen skip layout and paint (content-visibility) but stay in the DOM,
        // so scrolling, jumping to a pin and find-in-page keep working. The containment
        // would clip the hover toolbar above the row, so it is off while that shows.
        <div
          key={message.id}
          className="[contain-intrinsic-size:auto_72px] [content-visibility:auto] focus-within:[content-visibility:visible] hover:[content-visibility:visible] has-[[data-state=open]]:[content-visibility:visible]"
        >
          {newDay && <Separator>{formatDay(message.createdAt)}</Separator>}
          {message.id === firstUnread && (
            <div ref={divider} className="relative my-2 flex items-center px-6" role="separator">
              <span className="h-px flex-1 bg-destructive/50" />
              <span className="ml-2 text-[11px] font-semibold text-destructive uppercase">{t('chat.newMessages')}</span>
            </div>
          )}
          <MessageRow
            message={message}
            actions={actions}
            continued={continued && message.id !== firstUnread && !message.pinned}
            flash={message.id === flashId}
          />
        </div>
      ))}
    </div>
  )
}

function isAtBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
}

export function Separator({ children }: { children: ReactNode }) {
  return (
    <div className="relative my-3 flex items-center px-6" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span className="mx-3 rounded-full border bg-card px-3 py-0.5 text-xs font-medium text-muted-foreground">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function ChannelWelcome({ channel, meId }: { channel: Channel; meId: string }) {
  const t = useT()
  if (channel.kind === 'direct') {
    const self = otherParticipants(channel, meId).length === 0
    return (
      <div className="px-6 pt-8 pb-4">
        <span className="mb-3 flex">
          <ConversationAvatar conversation={channel} size="md" />
        </span>
        <h2 className="text-lg font-bold">
          {self ? channelTitle(channel, meId, t) : t('dm.welcome', { names: channelTitle(channel, meId, t) })}
        </h2>
        <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">{self ? t('dm.welcomeSelf') : t('dm.welcomeHint')}</p>
      </div>
    )
  }
  if (channel.kind === 'room') {
    return (
      <div className="px-6 pt-8 pb-4">
        <h2 className="text-lg font-bold">{t('rooms.welcomeTitle', { name: channel.name })}</h2>
        <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">{t('rooms.welcomeText')}</p>
      </div>
    )
  }
  return (
    <div className="px-6 pt-8 pb-4">
      <span className="mb-3 flex size-12 items-center justify-center rounded-xl bg-primary-soft text-primary">
        <ChannelIcon channel={channel} className="size-6" />
      </span>
      <h2 className="text-lg font-bold">{t('chat.welcomeTitle', { name: channel.name })}</h2>
      <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">
        {channel.visibility === 'private' ? t('chat.welcomePrivate') : t('chat.welcomeText')}
      </p>
    </div>
  )
}

interface MessageRowProps {
  message: Message
  actions: MessageActions
  continued?: boolean
  flash?: boolean
}

/**
 * One message with its reactions, thread preview and hover toolbar. Memoized: a new
 * message, a read marker or an edit elsewhere must not re-render every row, so a row
 * compares only what it reads. Reading a new field of `actions` means adding it here.
 */
export const MessageRow = memo(MessageRowView, (a: MessageRowProps, b: MessageRowProps) => {
  if (a.message !== b.message || a.continued !== b.continued || a.flash !== b.flash) return false
  const x = a.actions
  const y = b.actions
  if (x === y) return true
  const id = a.message.id
  return (
    x.orgId === y.orgId &&
    x.meId === y.meId &&
    (x.editingId === id) === (y.editingId === id) &&
    x.onEditingChange === y.onEditingChange &&
    x.canDelete === y.canDelete &&
    x.onDelete === y.onDelete &&
    x.onOpenThread === y.onOpenThread &&
    x.channel.joined === y.channel.joined &&
    x.channel.archivedAt === y.channel.archivedAt
  )
})

function MessageRowView({
  message,
  actions,
  continued = false,
  flash = false,
}: MessageRowProps) {
  const { orgId, channel, meId, editingId, onEditingChange, canDelete, onDelete, onOpenThread } = actions
  const t = useT()
  const qc = useQueryClient()
  const mine = message.author?.id === meId
  const editing = editingId === message.id
  const name = message.author?.displayName ?? t('chat.deletedUser')
  // Archived channels are read-only: no reactions, pins or edits.
  const member = channel.joined && !channel.archivedAt
  const canEdit = mine && member && !message.deleted
  const deletable = !message.deleted && canDelete(message)
  const mentionsMe = message.mentions?.some((m) => m.id === meId)
  const react = useToggleReaction(orgId, message, meId)
  const pin = useMutation({
    mutationFn: () =>
      message.pinned
        ? api.unpinMessage(orgId, message.channelId, message.id)
        : api.pinMessage(orgId, message.channelId, message.id),
    onSuccess: (updated) => replaceMessage(qc, orgId, updated),
  })
  const showToolbar = !editing && !message.deleted && (member || deletable)

  return (
    <article
      data-message-id={message.id}
      aria-label={`${name}, ${formatDateTime(message.createdAt)}`}
      className={cn(
        'group relative flex gap-3 px-6 transition-colors hover:bg-accent/40',
        continued ? 'py-0.5' : 'pt-2.5 pb-0.5',
        mentionsMe &&
          'bg-amber-50/70 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-amber-400 hover:bg-amber-50 dark:bg-amber-500/10 dark:hover:bg-amber-500/15',
        message.pinned && !mentionsMe && 'bg-amber-50/40 dark:bg-amber-500/5',
        editing && 'bg-primary-soft/40 hover:bg-primary-soft/40',
        flash && 'bg-primary-soft/70',
      )}
    >
      <div className="w-9 shrink-0">
        {continued ? (
          <time
            dateTime={message.createdAt}
            className="invisible block pt-0.5 text-right text-[10px] leading-5 text-muted-foreground group-hover:visible"
          >
            {formatTime(message.createdAt)}
          </time>
        ) : (
          <Avatar name={name} seed={message.author?.id ?? message.id} size="md" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {message.pinned && (
          <p className="flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            <PinIcon className="size-3" />
            {message.pinned.by ? t('chat.pinnedBy', { name: message.pinned.by.displayName }) : t('chat.pinned')}
          </p>
        )}
        {!continued && (
          <p className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold">{message.deleted ? t('chat.deletedTitle') : name}</span>
            <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)} className="text-xs text-muted-foreground">
              {formatTime(message.createdAt)}
            </time>
          </p>
        )}
        {message.deleted ? (
          <p className="text-[13px] text-muted-foreground italic">{t('chat.deletedMessage')}</p>
        ) : editing ? (
          <EditBox orgId={orgId} message={message} onDone={() => onEditingChange(null)} />
        ) : (
          <div className="text-[14px] leading-relaxed text-foreground/90">
            {message.body && <MessageText body={message.body} mentions={message.mentions} meId={meId} />}
            {message.editedAt && (
              <span className="text-[11px] text-muted-foreground" title={formatDateTime(message.editedAt)}>
                {t('chat.edited')}
              </span>
            )}
          </div>
        )}
        {!message.deleted && !!message.attachments?.length && <MessageAttachments orgId={orgId} attachments={message.attachments} />}
        <ReactionBar orgId={orgId} message={message} meId={meId} canReact={member} />
        {message.thread && onOpenThread && <ThreadPreview message={message} actions={actions} onOpen={() => onOpenThread(message)} />}
      </div>
      {showToolbar && (
        <div
          role="toolbar"
          aria-label={t('chat.messageActions')}
          className="absolute -top-3 right-6 hidden items-center rounded-lg border bg-card p-0.5 shadow-sm group-focus-within:flex group-hover:flex has-[[data-state=open]]:flex"
        >
          {member &&
            quickEmojis.slice(0, 3).map((e) => (
              <Button key={e} variant="ghost" size="icon-sm" aria-label={e} className="text-[15px]" onClick={() => react.mutate(e)}>
                {e}
              </Button>
            ))}
          {member && (
            <EmojiPicker onPick={(e) => react.mutate(e)}>
              <Button variant="ghost" size="icon-sm" aria-label={t('chat.addReaction')}>
                <SmilePlusIcon className="size-3.5" />
              </Button>
            </EmojiPicker>
          )}
          {member && onOpenThread && !message.parentId && (
            <ToolbarButton label={t('chat.reply')} onClick={() => onOpenThread(message)}>
              <MessageSquareReplyIcon className="size-3.5" />
            </ToolbarButton>
          )}
          {member && (
            <ToolbarButton label={message.pinned ? t('chat.unpin') : t('chat.pin')} onClick={() => pin.mutate()}>
              {message.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
            </ToolbarButton>
          )}
          {canEdit && (
            <ToolbarButton label={t('chat.editMessage')} onClick={() => onEditingChange(message.id)}>
              <PencilIcon className="size-3.5" />
            </ToolbarButton>
          )}
          {deletable && (
            <ToolbarButton label={t('chat.deleteMessage')} destructive onClick={() => onDelete(message)}>
              <Trash2Icon className="size-3.5" />
            </ToolbarButton>
          )}
        </div>
      )}
      {(react.error || pin.error) && (
        <p role="alert" className="absolute right-6 bottom-0 text-[11px] text-destructive">
          {errorMessage(react.error ?? pin.error)}
        </p>
      )}
    </article>
  )
}

function ToolbarButton({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string
  onClick: () => void
  destructive?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip content={label} side="top">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        className={cn(destructive && 'text-destructive hover:text-destructive')}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tooltip>
  )
}

/** The latest reply shown under its root, as in the mockup, with a link to the thread. */
function ThreadPreview({ message, actions, onOpen }: { message: Message; actions: MessageActions; onOpen: () => void }) {
  const t = useT()
  const thread = message.thread!
  const latest = thread.latest
  const name = latest.author?.displayName ?? t('chat.deletedUser')
  return (
    <div className="mt-2 ml-0.5 border-l-2 border-border pl-3">
      <div className="flex gap-2.5">
        <Avatar name={name} seed={latest.author?.id ?? latest.id} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">{name}</span>
            <time dateTime={latest.createdAt} className="text-[11px] text-muted-foreground">
              {formatTime(latest.createdAt)}
            </time>
          </p>
          <div className="line-clamp-3 text-[13px] leading-relaxed text-foreground/90">
            {latest.body ? <MessageText body={latest.body} mentions={latest.mentions} meId={actions.meId} /> : messagePreview(latest)}
          </div>
          <ReactionBar orgId={actions.orgId} message={latest} meId={actions.meId} canReact={actions.channel.joined} />
        </div>
      </div>
      <button
        onClick={onOpen}
        className="mt-1 rounded text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {t('chat.replies', { count: thread.replyCount })}
        <span className="font-normal text-muted-foreground"> · {formatRelative(thread.lastReplyAt)}</span>
      </button>
    </div>
  )
}

function EditBox({ orgId, message, onDone }: { orgId: string; message: Message; onDone: () => void }) {
  const t = useT()
  const qc = useQueryClient()
  // People edit names, not <@id> tokens; the tokens come back on save.
  const [{ text: original, names }] = useState(() => fromMentionTokens(message.body, message.mentions))
  const [value, setValue] = useState(original)
  const save = useMutation({
    mutationFn: () => api.editMessage(orgId, message.channelId, message.id, toMentionTokens(value, names)),
    onSuccess: (updated) => {
      replaceMessage(qc, orgId, updated)
      onDone()
    },
  })
  const submit = () => {
    if (!value.trim()) return
    if (value.trim() === original) onDone()
    else save.mutate()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onDone()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="mt-1 grid gap-1.5">
      <textarea
        autoFocus
        aria-label={t('chat.editMessage')}
        rows={Math.min(value.split('\n').length + 1, 10)}
        maxLength={4000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        className="w-full resize-none rounded-lg border border-input bg-card px-3 py-2 text-[14px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20"
      />
      {save.error && <p className="text-xs text-destructive">{errorMessage(save.error)}</p>}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] text-muted-foreground">{t('chat.editHint')}</span>
        <Button size="sm" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" onClick={submit} disabled={save.isPending || !value.trim()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}
