import type { Room, RoomAccess } from '@fudislte/api-client'
import { Badge, type BadgeVariant } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { DoorOpenIcon, LockKeyholeIcon, type LucideIcon, ShieldCheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { t, useT } from '../../i18n'
import { api, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'

/** Rooms the caller can enter, kept current by live events. */
export function useRooms() {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  // Live events keep it current and a reconnect resyncs it; focusing the window need not.
  return useQuery({ queryKey: queryKeys.rooms(orgId), queryFn: () => api.rooms(orgId), refetchOnWindowFocus: false })
}

export const accessIcons: Record<RoomAccess, LucideIcon> = {
  open: DoorOpenIcon,
  protected: LockKeyholeIcon,
  restricted: ShieldCheckIcon,
}

const accessBadges: Record<RoomAccess, BadgeVariant> = { open: 'success', protected: 'primary', restricted: 'violet' }

export function AccessBadge({ access, className }: { access: RoomAccess; className?: string }) {
  const tr = useT()
  const Icon = accessIcons[access]
  return (
    <Badge variant={accessBadges[access]} className={className}>
      <Icon />
      {tr(`rooms.access.${access}`)}
    </Badge>
  )
}

/** Admission lengths offered in the room dialogs, in minutes. */
export const admissionChoices = [15, 60, 4 * 60, 12 * 60, 24 * 60, 7 * 24 * 60, 30 * 24 * 60]

/** "30 dakika", "12 saat", "7 gün". */
export function formatMinutes(minutes: number): string {
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) return t('rooms.days', { count: minutes / (24 * 60) })
  if (minutes >= 60 && minutes % 60 === 0) return t('rooms.hours', { count: minutes / 60 })
  if (minutes >= 24 * 60) return t('rooms.days', { count: Math.round(minutes / (24 * 60)) })
  if (minutes >= 60) return t('rooms.hours', { count: Math.round(minutes / 60) })
  return t('rooms.minutes', { count: Math.max(1, Math.round(minutes)) })
}

/** Minutes until iso, refreshed every 30 seconds; 0 once it has passed. */
export function useMinutesLeft(iso: string | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!iso) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [iso])
  if (!iso) return null
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60_000))
}

/** The caller's admission: "Erişim 11 saat sonra bitiyor" or "Süresiz erişim". */
export function AdmissionLabel({ room }: { room: Room }) {
  const tr = useT()
  const left = useMinutesLeft(room.admissionExpiresAt)
  if (left === null) return <>{tr('rooms.lasting')}</>
  return <>{tr('rooms.expiresIn', { time: formatMinutes(left) })}</>
}
