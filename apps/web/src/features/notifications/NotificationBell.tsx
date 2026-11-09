import type { AppNotification } from '@fudislte/api-client'
import { Avatar, Button, cn, Popover, PopoverContent, PopoverTrigger, Spinner, Tooltip } from '@fudislte/ui'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellIcon, BellOffIcon, BellRingIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { t as translate, useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { useWorkspace } from '../../shell/context'
import { messagePreview } from '../chat/text'
import { desktopSupported } from './desktop'

type NotificationList = { notifications: AppNotification[]; unreadCount: number }

/** Puts a pushed notification at the top of the bell's list. */
export function addNotification(qc: QueryClient, orgId: string, n: AppNotification) {
  qc.setQueryData<NotificationList>(queryKeys.notifications(orgId), (data) =>
    !data || data.notifications.some((x) => x.id === n.id)
      ? data
      : { notifications: [n, ...data.notifications].slice(0, 50), unreadCount: data.unreadCount + 1 },
  )
}

/** "Ali seni #backend kanalında andı" and similar, in the current language. */
export function notificationTitle(n: AppNotification, t = translate): string {
  const name = n.actor?.displayName ?? t('chat.deletedUser')
  const channel = n.channelKind === 'room' ? n.channelName : `#${n.channelName}`
  if (n.kind === 'mention') return n.channelKind === 'direct' ? t('notify.mentionDirect', { name }) : t('notify.mention', { name, channel })
  return n.channelKind === 'direct' ? t('notify.replyDirect', { name }) : t('notify.reply', { name, channel })
}

/** The bell in the top bar: mentions and replies, newest first. */
export function NotificationBell() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [permission, setPermission] = useState(() => (desktopSupported() ? Notification.permission : 'denied'))
  const list = useQuery({ queryKey: queryKeys.notifications(orgId), queryFn: () => api.notifications(orgId) })
  const unread = list.data?.unreadCount ?? 0

  const markRead = useMutation({
    mutationFn: (input: { ids?: string[]; all?: boolean }) => api.readNotifications(orgId, input),
    onMutate: (input) =>
      qc.setQueryData<NotificationList>(queryKeys.notifications(orgId), (data) => {
        if (!data) return data
        const notifications = data.notifications.map((n) => (input.all || input.ids?.includes(n.id) ? { ...n, read: true } : n))
        return { notifications, unreadCount: input.all ? 0 : Math.max(0, data.unreadCount - (input.ids?.length ?? 0)) }
      }),
    onSuccess: ({ unreadCount }) =>
      qc.setQueryData<NotificationList>(queryKeys.notifications(orgId), (data) => data && { ...data, unreadCount }),
  })

  const openOne = (n: AppNotification) => {
    if (!n.read) markRead.mutate({ ids: [n.id] })
    setOpen(false)
    const thread = n.message.parentId ? `?thread=${n.message.parentId}` : ''
    navigate(`/w/${workspace.organization.slug}/c/${n.channelId}${thread}`)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={t('notify.title')} side="bottom">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={unread ? t('notify.unread', { count: unread }) : t('notify.title')}
            className="relative size-9 text-muted-foreground data-[state=open]:text-foreground"
          >
            <BellIcon className="size-[18px]" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[400px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-[15px] font-semibold">{t('notify.title')}</h2>
          {unread > 0 && (
            <button
              onClick={() => markRead.mutate({ all: true })}
              className="rounded text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {t('notify.readAll')}
            </button>
          )}
        </div>
        <div className="max-h-[28rem] overflow-y-auto">
          {list.isPending && (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          )}
          {list.error && <p className="p-4 text-[13px] text-destructive">{errorMessage(list.error)}</p>}
          {list.data?.notifications.length === 0 && (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <BellOffIcon className="size-6 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">{t('notify.empty')}</p>
            </div>
          )}
          <ul className="divide-y">
            {list.data?.notifications.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => openOne(n)}
                  className={cn(
                    'flex w-full gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60',
                    !n.read && 'bg-primary-soft/40',
                  )}
                >
                  <Avatar name={n.actor?.displayName ?? '?'} seed={n.actor?.id ?? n.id} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{notificationTitle(n, t)}</span>
                    <span className="line-clamp-2 text-[13px] text-muted-foreground">
                      {messagePreview(n.message)}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{formatRelative(n.createdAt)}</span>
                  </span>
                  {!n.read && <span aria-label={t('notify.unreadOne')} className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
        {desktopSupported() && permission === 'default' && (
          <div className="flex items-center gap-3 border-t bg-muted/40 px-4 py-3">
            <BellRingIcon className="size-4 shrink-0 text-primary" />
            <p className="flex-1 text-xs text-muted-foreground">{t('notify.desktopAsk')}</p>
            <Button size="sm" variant="outline" onClick={() => void Notification.requestPermission().then(setPermission)}>
              {t('notify.desktopEnable')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
