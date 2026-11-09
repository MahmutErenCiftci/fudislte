import { Alert, Avatar, Button, Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@fudislte/ui'
import { useInfiniteQuery } from '@tanstack/react-query'
import { FileClockIcon } from 'lucide-react'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { auditLabel, describeEvent } from '../../lib/audit'
import { formatDateTime } from '../../lib/format'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { RequirePermission, SettingsCard } from './SettingsLayout'

export function AuditLog() {
  const { workspace } = useWorkspace()
  return (
    <RequirePermission allowed={can(workspace, 'audit.view')}>
      <AuditTable />
    </RequirePermission>
  )
}

function AuditTable() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const events = useInfiniteQuery({
    queryKey: queryKeys.audit(orgId),
    queryFn: ({ pageParam }) => api.auditEvents(orgId, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  })
  const rows = events.data?.pages.flatMap((p) => p.events) ?? []

  return (
    <SettingsCard icon={FileClockIcon} title={t('audit.title')} description={t('audit.description')}>
      {events.isPending && <Spinner />}
      {events.error && <Alert variant="error">{errorMessage(events.error)}</Alert>}
      {events.data && (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-44">{t('audit.colTime')}</TableHead>
                <TableHead className="w-48">{t('audit.colActor')}</TableHead>
                <TableHead>{t('audit.colEvent')}</TableHead>
                <TableHead className="w-32">{t('audit.colAddress')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar name={e.actor?.displayName ?? '?'} seed={e.actor?.id} size="sm" />
                      <span className="truncate">{e.actor?.displayName ?? t('audit.deletedUser')}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{auditLabel(e.action)}</p>
                    {describeEvent(e) && <p className="text-muted-foreground">{describeEvent(e)}</p>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{e.ipAddress}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {events.hasNextPage && (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => events.fetchNextPage()} disabled={events.isFetchingNextPage}>
            {t('audit.loadMore')}
          </Button>
        </div>
      )}
    </SettingsCard>
  )
}
