import type { Channel } from '@fudislte/api-client'
import {
  Alert,
  Avatar,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronUpIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { presenceDot, usePresenceMap } from '../presence/presence'
import { MemberPicker } from './MemberPicker'
import { channelTitle, otherParticipants } from './names'

const SIDEBAR_LIMIT = 8
const MAX_OTHERS = 8

export function useConversations() {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  // Live events keep it current and a reconnect resyncs it; focusing the window need not.
  return useQuery({ queryKey: queryKeys.conversations(orgId), queryFn: () => api.conversations(orgId), refetchOnWindowFocus: false })
}

/** Opens (finds or creates) a conversation and shows it. */
export function useOpenConversation(onOpened?: () => void) {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: (userIds: string[]) => api.openConversation(orgId, userIds),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: queryKeys.conversations(orgId) })
      onOpened?.()
      navigate(`/w/${workspace.organization.slug}/c/${c.id}`)
    },
  })
}

const groupSizes = { xs: 'size-5 text-[10px]', sm: 'size-7 text-[11px]', md: 'size-9 text-[13px]' }

/** The other person's avatar, or for a group the number of other people. */
export function ConversationAvatar({ conversation, size = 'xs' }: { conversation: Channel; size?: 'xs' | 'sm' | 'md' }) {
  const t = useT()
  const { me } = useWorkspace()
  const presence = usePresenceMap()
  const others = otherParticipants(conversation, me.user.id)
  if (others.length <= 1) {
    const person = others[0] ?? { id: me.user.id, displayName: me.user.displayName }
    const p = presence.get(person.id)
    return <Avatar name={person.displayName} seed={person.id} size={size} dot={presenceDot(p?.state, p?.status, t)} />
  }
  return (
    <span
      aria-label={t('chat.members', { count: others.length + 1 })}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground',
        groupSizes[size],
      )}
    >
      {others.length + 1}
    </span>
  )
}

/** "Direkt mesajlar" section of the sidebar, most recent first. */
export function DirectMessagesSidebar() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const conversations = useConversations()
  const [expanded, setExpanded] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const root = `/w/${workspace.organization.slug}`
  const canStart = can(workspace, 'members.view')
  const all = conversations.data ?? []
  const shown = expanded ? all : all.slice(0, SIDEBAR_LIMIT)

  if (all.length === 0 && !canStart) return null

  return (
    <section aria-labelledby="sidebar-dms" className="grid gap-0.5">
      <div className="flex h-7 items-center justify-between pr-1 pl-3">
        <h2 id="sidebar-dms" className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {t('dm.title')}
        </h2>
        {canStart && (
          <Tooltip content={t('dm.new')}>
            <button
              aria-label={t('dm.new')}
              onClick={() => setNewOpen(true)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <PlusIcon className="size-4" />
            </button>
          </Tooltip>
        )}
      </div>
      <ul className="grid gap-px">
        {shown.map((c) => {
          const unread = c.unreadCount > 0
          return (
            <li key={c.id}>
              <NavLink
                to={`${root}/c/${c.id}`}
                className={({ isActive }) =>
                  cn(
                    'relative flex h-8 items-center gap-2.5 rounded-lg px-3 text-[14px] text-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                    unread && 'font-semibold text-foreground',
                    isActive &&
                      'bg-primary-soft font-medium text-primary-soft-foreground before:absolute before:top-1 before:-left-1 before:h-6 before:w-[3px] before:rounded-full before:bg-primary hover:bg-primary-soft hover:text-primary-soft-foreground',
                  )
                }
              >
                <ConversationAvatar conversation={c} />
                <span className="min-w-0 flex-1 truncate">{channelTitle(c, me.user.id, t)}</span>
                {unread && (
                  <span
                    aria-label={t('chat.unread', { count: c.unreadCount })}
                    className="rounded-full bg-primary px-1.5 py-px text-[11px] leading-4 font-semibold text-primary-foreground"
                  >
                    {c.unreadCount > 99 ? '99+' : c.unreadCount}
                  </span>
                )}
              </NavLink>
            </li>
          )
        })}
      </ul>
      {all.length > SIDEBAR_LIMIT && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {expanded ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          {expanded ? t('dm.showLess') : t('dm.showMore')}
        </button>
      )}
      {canStart && <NewMessageDialog open={newOpen} onOpenChange={setNewOpen} />}
    </section>
  )
}

export function NewMessageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const [selected, setSelected] = useState<string[]>([])
  const close = () => {
    onOpenChange(false)
    setSelected([])
    start.reset()
  }
  const start = useOpenConversation(close)
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dm.new')}</DialogTitle>
          <DialogDescription>{t('dm.newDescription')}</DialogDescription>
        </DialogHeader>
        {start.error && <Alert variant="error">{errorMessage(start.error)}</Alert>}
        <MemberPicker selected={selected} onChange={setSelected} max={MAX_OTHERS} />
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button disabled={selected.length === 0 || start.isPending} onClick={() => start.mutate(selected)}>
            {t('dm.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
