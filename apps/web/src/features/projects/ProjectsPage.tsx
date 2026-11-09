import type { Project } from '@fudislte/api-client'
import { Alert, Badge, Button, cn, Spinner } from '@fudislte/ui'
import { FolderKanbanIcon, LockIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { errorMessage } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { PageHeader } from '../../shell/PageHeader'
import { AvatarStack } from '../meetings/meetings'
import { CreateProjectDialog } from './CreateProjectDialog'
import { ProjectIcon, useProjectLinks, useProjects } from './projects'

/** /w/:slug/projects — the projects the caller may see (mockup "Yeni 07"). */
export function ProjectsPage() {
  const t = useT()
  const { workspace } = useWorkspace()
  const [archived, setArchived] = useState(false)
  const projects = useProjects(archived)
  const [creating, setCreating] = useState(false)
  const canCreate = can(workspace, 'projects.create')

  return (
    <>
      <PageHeader
        icon={FolderKanbanIcon}
        title={t('projects.title')}
        description={t('projects.description')}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              {t('projects.create')}
            </Button>
          )
        }
      >
        <nav className="mt-5 flex gap-1 border-b">
          {([false, true] as const).map((a) => (
            <button
              key={String(a)}
              type="button"
              aria-current={archived === a ? 'page' : undefined}
              onClick={() => setArchived(a)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:text-foreground',
                archived === a ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {a ? t('projects.archivedTab') : t('projects.activeTab')}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="px-6 py-6">
        {projects.isPending && (
          <div className="flex justify-center p-10">
            <Spinner label={t('common.loading')} />
          </div>
        )}
        {projects.error && <Alert variant="error">{errorMessage(projects.error)}</Alert>}
        {projects.data?.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-12 text-center">
            <FolderKanbanIcon className="size-8 text-muted-foreground" />
            <p className="text-[15px] font-medium">{archived ? t('projects.emptyArchived') : t('projects.empty')}</p>
            {!archived && <p className="max-w-md text-[13px] text-muted-foreground">{t('projects.emptyHint')}</p>}
            {!archived && canCreate && (
              <Button className="mt-2" onClick={() => setCreating(true)}>
                <PlusIcon />
                {t('projects.create')}
              </Button>
            )}
          </div>
        )}
        {projects.data && projects.data.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
            {projects.data.map((p) => (
              <li key={p.id}>
                <ProjectCard project={p} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {canCreate && <CreateProjectDialog open={creating} onOpenChange={setCreating} />}
    </>
  )
}

function ProjectCard({ project }: { project: Project }) {
  const t = useT()
  const links = useProjectLinks()
  const progress = project.taskCount > 0 ? Math.round((project.doneCount / project.taskCount) * 100) : 0
  return (
    <Link
      to={links.project(project.id)}
      className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4 outline-none transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-start gap-3">
        <ProjectIcon project={project} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{project.name}</p>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{project.key}</span>
            {project.visibility === 'private' && (
              <span className="flex items-center gap-1">
                <LockIcon className="size-3" />
                {t('projects.visibility.private')}
              </span>
            )}
          </p>
        </div>
        {project.role && <Badge variant={project.role === 'lead' ? 'primary' : 'outline'}>{t(`projects.role.${project.role}`)}</Badge>}
      </div>
      <p className="line-clamp-2 min-h-[2lh] text-[13px] text-muted-foreground">{project.description}</p>
      <div>
        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
          <span>{t('projects.progress', { done: project.doneCount, total: project.taskCount })}</span>
          <span>{t('projects.percent', { value: progress })}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
          <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
        <AvatarStack people={project.people} max={4} />
        <span>{t('projects.memberCount', { count: project.memberCount })}</span>
      </div>
    </Link>
  )
}
