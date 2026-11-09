import type { Channel } from '@fudislte/api-client'
import { cn, Tooltip } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { CompassIcon, HashIcon, LockIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router'

import { useT } from '../../i18n'
import { api, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { BrowseChannelsDialog } from './BrowseChannelsDialog'
import { CreateChannelDialog } from './CreateChannelDialog'

export function useChannels() {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  // Live events keep it current and a reconnect resyncs it; focusing the window need not.
  return useQuery({ queryKey: queryKeys.channels(orgId), queryFn: () => api.channels(orgId), refetchOnWindowFocus: false })
}

export function ChannelIcon({ channel, className }: { channel: Pick<Channel, 'visibility'>; className?: string }) {
  const Icon = channel.visibility === 'private' ? LockIcon : HashIcon
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', className)} />
}

/** "Kanallar" section of the sidebar: joined channels with unread badges. */
export function ChannelSidebar() {
  const t = useT()
  const { workspace } = useWorkspace()
  const channels = useChannels()
  const [createOpen, setCreateOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const root = `/w/${workspace.organization.slug}`
  const canCreate = can(workspace, 'channels.create')
  const canBrowse = can(workspace, 'channels.join')

  if (!channels.data?.length && !canCreate && !canBrowse) return null

  return (
    <section aria-labelledby="sidebar-channels" className="grid gap-0.5">
      <div className="flex h-7 items-center justify-between pr-1 pl-3">
        <h2 id="sidebar-channels" className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {t('chat.channels')}
        </h2>
        {canCreate && (
          <Tooltip content={t('chat.newChannel')}>
            <button
              aria-label={t('chat.newChannel')}
              onClick={() => setCreateOpen(true)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <PlusIcon className="size-4" />
            </button>
          </Tooltip>
        )}
      </div>
      <ul className="grid gap-px">
        {channels.data?.map((c) => {
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
                <ChannelIcon channel={c} className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
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
      {canBrowse && (
        <button
          onClick={() => setBrowseOpen(true)}
          className="flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <CompassIcon className="size-4" />
          {t('chat.browse')}
        </button>
      )}
      {canCreate && <CreateChannelDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {canBrowse && <BrowseChannelsDialog open={browseOpen} onOpenChange={setBrowseOpen} />}
    </section>
  )
}
