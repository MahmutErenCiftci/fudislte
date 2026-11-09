import type { Board } from '@fudislte/api-client'
import { Alert, Button, Spinner } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { AudioLinesIcon, PenToolIcon, PlusIcon, ShapesIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { PageHeader } from '../../shell/PageHeader'
import { ProjectIcon, useProjects } from '../projects/projects'
import { BoardDialog } from './BoardDialog'

/** /w/:slug/boards — "Beyaz Tahta": the boards the caller may see (mockup "Yeni 08"). */
export function BoardsPage() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const boards = useQuery({ queryKey: queryKeys.boards(orgId), queryFn: () => api.boards(orgId) })
  const projects = useProjects()
  const [creating, setCreating] = useState(false)
  const canCreate = can(workspace, 'boards.create') || (projects.data ?? []).some((p) => p.canEdit)

  return (
    <>
      <PageHeader
        icon={PenToolIcon}
        title={t('boards.title')}
        description={t('boards.description')}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              {t('boards.create')}
            </Button>
          )
        }
      />
      <div className="px-6 py-6">
        {boards.isPending && (
          <div className="flex justify-center p-10">
            <Spinner label={t('common.loading')} />
          </div>
        )}
        {boards.error && <Alert variant="error">{errorMessage(boards.error)}</Alert>}
        {boards.data?.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-12 text-center">
            <ShapesIcon className="size-8 text-muted-foreground" />
            <p className="text-[15px] font-medium">{t('boards.empty')}</p>
            <p className="max-w-md text-[13px] text-muted-foreground">{t('boards.emptyHint')}</p>
            {canCreate && (
              <Button className="mt-2" onClick={() => setCreating(true)}>
                <PlusIcon />
                {t('boards.create')}
              </Button>
            )}
          </div>
        )}
        {boards.data && boards.data.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4">
            {boards.data.map((b) => (
              <li key={b.id}>
                <BoardCard board={b} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {canCreate && <BoardDialog open={creating} onOpenChange={setCreating} />}
    </>
  )
}

function BoardCard({ board }: { board: Board }) {
  const t = useT()
  const { workspace } = useWorkspace()
  return (
    <Link
      to={`/w/${workspace.organization.slug}/b/${board.id}`}
      className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4 outline-none transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
          <PenToolIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{board.title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            {board.project ? (
              <>
                <ProjectIcon project={board.project} size="sm" />
                {board.project.name}
              </>
            ) : (
              t('boards.workspaceBoard')
            )}
          </p>
        </div>
      </div>
      <p className="line-clamp-2 min-h-[2lh] text-[13px] text-muted-foreground">{board.description}</p>
      <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
        <span>{t('boards.shapes', { count: board.elementCount })}</span>
        {board.room && (
          <span className="flex items-center gap-1 truncate">
            <AudioLinesIcon className="size-3.5" />
            {board.room.name}
          </span>
        )}
        <span className="ml-auto">{formatRelative(board.updatedAt)}</span>
      </div>
    </Link>
  )
}
