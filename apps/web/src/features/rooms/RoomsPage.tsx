import type { Room } from '@fudislte/api-client'
import { Alert, Button, Spinner } from '@fudislte/ui'
import { AudioLinesIcon, PlusIcon, UsersIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { errorMessage } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { PageHeader } from '../../shell/PageHeader'
import { CreateRoomDialog } from './CreateRoomDialog'
import { AccessBadge, accessIcons, AdmissionLabel, useRooms } from './rooms'

/** /w/:slug/rooms — the rooms the caller can enter (mockup "Yeni 05"). */
export function RoomsPage() {
  const t = useT()
  const { workspace } = useWorkspace()
  const rooms = useRooms()
  const [creating, setCreating] = useState(false)
  const canCreate = can(workspace, 'rooms.create')

  return (
    <>
      <PageHeader
        icon={AudioLinesIcon}
        title={t('rooms.title')}
        description={t('rooms.description')}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              {t('rooms.create')}
            </Button>
          )
        }
      />
      <div className="px-6 py-6">
        {rooms.isPending && (
          <div className="flex justify-center p-10">
            <Spinner label={t('common.loading')} />
          </div>
        )}
        {rooms.error && <Alert variant="error">{errorMessage(rooms.error)}</Alert>}
        {rooms.data?.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-12 text-center">
            <AudioLinesIcon className="size-8 text-muted-foreground" />
            <p className="text-[15px] font-medium">{t('rooms.empty')}</p>
            <p className="max-w-md text-[13px] text-muted-foreground">{t('rooms.emptyHint')}</p>
            {canCreate && (
              <Button className="mt-2" onClick={() => setCreating(true)}>
                <PlusIcon />
                {t('rooms.create')}
              </Button>
            )}
          </div>
        )}
        {rooms.data && rooms.data.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
            {rooms.data.map((room) => (
              <li key={room.id}>
                <RoomCard room={room} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {canCreate && <CreateRoomDialog open={creating} onOpenChange={setCreating} />}
    </>
  )
}

function RoomCard({ room }: { room: Room }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const Icon = accessIcons[room.access]
  return (
    <Link
      to={`/w/${workspace.organization.slug}/r/${room.id}`}
      className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4 outline-none transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{room.name}</p>
          <AccessBadge access={room.access} className="mt-1" />
        </div>
        {room.unreadCount > 0 && (
          <span
            aria-label={t('chat.unread', { count: room.unreadCount })}
            className="rounded-full bg-primary px-1.5 py-px text-[11px] leading-4 font-semibold text-primary-foreground"
          >
            {room.unreadCount > 99 ? '99+' : room.unreadCount}
          </span>
        )}
      </div>
      <p className="line-clamp-2 min-h-[2lh] text-[13px] text-muted-foreground">{room.topic}</p>
      <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <UsersIcon className="size-3.5" />
          {t('rooms.people', { count: room.memberCount })}
        </span>
        <span className="ml-auto font-medium text-foreground/80">
          {room.admitted ? <AdmissionLabel room={room} /> : room.needsPassword ? t('rooms.access.protected') : t('rooms.enter')}
        </span>
      </div>
    </Link>
  )
}
