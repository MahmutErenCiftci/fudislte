import type { Room } from '@fudislte/api-client'
import { Alert, Button, Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { AudioLinesIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { AccessBadge } from '../rooms/rooms'
import { RoomSettingsDialog } from '../rooms/RoomSettingsDialog'
import { RequirePermission, SettingsCard } from './SettingsLayout'

/** Settings → Rooms: every room's security at a glance, for rooms.manage holders. */
export function RoomsSettings() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const allowed = can(workspace, 'rooms.manage')
  const rooms = useQuery({ queryKey: queryKeys.allRooms(orgId), queryFn: () => api.rooms(orgId, true), enabled: allowed })
  const [managing, setManaging] = useState<Room | null>(null)
  // Keep the dialog on the freshest copy after a save refetches the list.
  const current = managing && (rooms.data?.find((r) => r.id === managing.id) ?? managing)

  return (
    <RequirePermission allowed={allowed}>
      <SettingsCard icon={AudioLinesIcon} title={t('settings.rooms')} description={t('rooms.adminDescription')}>
        {rooms.isPending && <Spinner />}
        {rooms.error && <Alert variant="error">{errorMessage(rooms.error)}</Alert>}
        {rooms.data?.length === 0 && <p className="text-[13px] text-muted-foreground">{t('rooms.empty')}</p>}
        {rooms.data && rooms.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('rooms.colRoom')}</TableHead>
                <TableHead>{t('rooms.colAccess')}</TableHead>
                <TableHead>{t('rooms.colPassword')}</TableHead>
                <TableHead>{t('rooms.colInside')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rooms.data.map((room) => (
                <TableRow key={room.id}>
                  <TableCell>
                    {room.admitted || room.canEnter ? (
                      <Link
                        to={`/w/${workspace.organization.slug}/r/${room.id}`}
                        className="font-medium hover:underline"
                      >
                        {room.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{room.name}</span>
                    )}
                    {room.topic && <span className="block max-w-xs truncate text-xs text-muted-foreground">{room.topic}</span>}
                  </TableCell>
                  <TableCell>
                    <AccessBadge access={room.access} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {room.passwordChangedAt ? formatRelative(room.passwordChangedAt) : '—'}
                  </TableCell>
                  <TableCell>{t('rooms.people', { count: room.memberCount })}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => setManaging(room)}>
                      {t('rooms.manage')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsCard>
      {current && (
        <RoomSettingsDialog room={current} tab="security" open onOpenChange={(o) => !o && setManaging(null)} />
      )}
    </RequirePermission>
  )
}
