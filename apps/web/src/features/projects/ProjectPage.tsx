import type { ProjectDetail, Task, WorkflowStatus } from '@fudislte/api-client'
import {
  Alert,
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  CalendarDaysIcon,
  CheckIcon,
  EllipsisIcon,
  KanbanIcon,
  ListIcon,
  LockIcon,
  LogInIcon,
  LogOutIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
  SettingsIcon,
  Share2Icon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { type MessageKey, useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { usePersistentState, useShell, useWorkspace } from '../../shell/context'
import { AvatarStack } from '../meetings/meetings'
import { taskSaved } from './cache'
import { CreateTaskDialog } from './CreateTaskDialog'
import { emptyFilter, filterTasks, type TaskFilter } from './filters'
import { OverviewTab } from './OverviewTab'
import { ProjectAside } from './ProjectAside'
import { ProjectSettings } from './ProjectSettings'
import { ProjectIcon, useProject, useProjectTasks } from './projects'
import { byRank, rankAt } from './rank'
import { SprintsTab } from './SprintsTab'
import { TaskBoard, type TaskMove } from './TaskBoard'
import { TaskDialog } from './TaskDialog'
import { TaskFilters } from './TaskFilters'
import { TaskCalendar, TaskList } from './TaskViews'

type Tab = 'tasks' | 'overview' | 'sprints' | 'settings'
type View = 'board' | 'list' | 'calendar'

const tabLabels: Record<Tab, MessageKey> = {
  tasks: 'projects.tab.tasks',
  overview: 'projects.tab.overview',
  sprints: 'projects.tab.sprints',
  settings: 'projects.tab.settings',
}

/** /w/:slug/p/:projectId — a project (mockup "Yeni 07"); ?tab=, ?view= and ?task= make every part linkable. */
export function ProjectPage() {
  const t = useT()
  const { projectId = '' } = useParams()
  const { workspace } = useWorkspace()
  const project = useProject(projectId)
  if (project.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }
  if (!project.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-[14px] text-muted-foreground">{t('projects.notFound')}</p>
        <Button variant="outline" asChild>
          <Link to={`/w/${workspace.organization.slug}/projects`}>{t('projects.back')}</Link>
        </Button>
      </div>
    )
  }
  return <ProjectView key={project.data.id} project={project.data} />
}

function ProjectView({ project }: { project: ProjectDetail }) {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const tasks = useProjectTasks(project.id)
  const tabs: Tab[] = project.canManage ? ['tasks', 'overview', 'sprints', 'settings'] : ['tasks', 'overview', 'sprints']
  const requested = params.get('tab') as Tab | null
  const tab: Tab = requested && tabs.includes(requested) ? requested : 'tasks'
  const taskId = params.get('task')
  const setParam = (key: string, value: string | null) =>
    setParams((p) => {
      if (value === null) p.delete(key)
      else p.set(key, value)
      return p
    })
  const openTask = (task: Task) => setParam('task', task.id)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectHeader project={project} onSettings={() => setParam('tab', 'settings')} />
      <nav aria-label={t('projects.tabs')} className="flex shrink-0 gap-1 border-b px-6">
        {tabs.map((k) => (
          <button
            key={k}
            type="button"
            aria-current={tab === k ? 'page' : undefined}
            onClick={() => setParam('tab', k === 'tasks' ? null : k)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:text-foreground',
              tab === k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(tabLabels[k])}
          </button>
        ))}
      </nav>
      {tasks.error && (
        <div className="px-6 pt-4">
          <Alert variant="error">{errorMessage(tasks.error)}</Alert>
        </div>
      )}
      {tab === 'tasks' && <TasksTab project={project} tasks={tasks.data} onOpen={openTask} />}
      {tab === 'overview' && <OverviewTab project={project} tasks={tasks.data ?? []} onOpen={openTask} />}
      {tab === 'sprints' && (
        <SprintsTab
          project={project}
          tasks={tasks.data ?? []}
          onOpen={openTask}
          onShowBoard={(sprintId) =>
            setParams((p) => {
              p.delete('tab')
              p.set('sprint', sprintId)
              return p
            })
          }
        />
      )}
      {tab === 'settings' && <ProjectSettings project={project} />}
      {taskId && <TaskDialog key={taskId} project={project} taskId={taskId} onClose={() => setParam('task', null)} />}
    </div>
  )
}

function ProjectHeader({ project, onSettings }: { project: ProjectDetail; onSettings: () => void }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const canJoin = project.role === '' && project.visibility === 'public' && project.status === 'active'
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.project(orgId, project.id) })
    void qc.invalidateQueries({ queryKey: queryKeys.projects(orgId) })
  }
  const join = useMutation({ mutationFn: () => api.joinProject(orgId, project.id), onSuccess: refresh })
  const leave = useMutation({
    mutationFn: () => api.removeProjectMember(orgId, project.id, me.user.id),
    onSuccess: () => {
      refresh()
      if (project.visibility === 'private') navigate(`/w/${workspace.organization.slug}/projects`)
    },
  })
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.archiveProject(orgId, project.id, archived),
    onSuccess: (saved) => {
      qc.setQueryData(queryKeys.project(orgId, project.id), saved)
      void qc.invalidateQueries({ queryKey: queryKeys.projects(orgId) })
    },
  })
  const copyLink = () =>
    void navigator.clipboard?.writeText(window.location.href.split('?')[0] ?? '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  const error = join.error ?? leave.error ?? archive.error

  return (
    <header className="shrink-0 px-6 pt-4 pb-3">
      <Link
        to={`/w/${workspace.organization.slug}/projects`}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('projects.back')}
      </Link>
      <div className="flex items-start gap-4">
        <ProjectIcon project={project} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <span className="truncate">{project.name}</span>
            {project.visibility === 'private' && <LockIcon className="size-4 shrink-0 text-muted-foreground" aria-label={t('projects.visibility.private')} />}
            {project.status === 'archived' && <Badge variant="amber">{t('projects.archived')}</Badge>}
          </h1>
          {project.description && <p className="mt-1 line-clamp-2 text-[14px] text-muted-foreground">{project.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AvatarStack people={project.members.map((m) => m.user)} max={4} />
          {canJoin && (
            <Button variant="outline" onClick={() => join.mutate()} disabled={join.isPending}>
              <LogInIcon />
              {t('projects.join')}
            </Button>
          )}
          <Tooltip content={copied ? t('common.copied') : t('projects.copyLink')} side="bottom">
            <Button variant="outline" onClick={copyLink}>
              {copied ? <CheckIcon /> : <Share2Icon />}
              {t('projects.share')}
            </Button>
          </Tooltip>
          {(project.role !== '' || project.canManage) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="size-9" aria-label={t('projects.options')}>
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {project.canManage && (
                  <DropdownMenuItem onSelect={onSettings}>
                    <SettingsIcon />
                    {t('projects.settings')}
                  </DropdownMenuItem>
                )}
                {project.canManage && (
                  <DropdownMenuItem onSelect={() => archive.mutate(project.status === 'active')}>
                    {project.status === 'active' ? <ArchiveIcon /> : <ArchiveRestoreIcon />}
                    {project.status === 'active' ? t('projects.archive') : t('projects.restore')}
                  </DropdownMenuItem>
                )}
                {project.role !== '' && project.status === 'active' && (
                  <DropdownMenuItem onSelect={() => leave.mutate()} variant="destructive">
                    <LogOutIcon />
                    {t('projects.leave')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {error && (
        <Alert variant="error" className="mt-3">
          {errorMessage(error)}
        </Alert>
      )}
    </header>
  )
}

function TasksTab({ project, tasks, onOpen }: { project: ProjectDetail; tasks: Task[] | undefined; onOpen: (task: Task) => void }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const view: View = params.get('view') === 'list' ? 'list' : params.get('view') === 'calendar' ? 'calendar' : 'board'
  const [filter, setFilter] = useState<TaskFilter>(() => ({ ...emptyFilter, sprint: params.get('sprint') ?? '' }))
  const [creating, setCreating] = useState(false)
  const [asideOpen, setAsideOpen] = usePersistentState('fudislte.projectAside', true)
  const { setAsideTaken } = useShell()
  useEffect(() => {
    setAsideTaken(asideOpen)
    return () => setAsideTaken(false)
  }, [asideOpen, setAsideTaken])
  const shown = useMemo(() => filterTasks(tasks ?? [], filter, me.user.id), [tasks, filter, me.user.id])
  const key = queryKeys.projectTasks(orgId, project.id)

  const move = useMutation({
    mutationFn: ({ task, status, rank }: TaskMove) => api.updateTask(orgId, project.id, task.id, { statusId: status.id, rank }),
    onMutate: ({ task, status, rank }) => {
      qc.setQueryData<Task[]>(key, (list) =>
        list?.map((x) =>
          x.id === task.id ? { ...x, rank: rank ?? x.rank, status: { id: status.id, name: status.name, category: status.category, color: status.color } } : x,
        ),
      )
    },
    onSuccess: (saved) => taskSaved(qc, orgId, saved),
    onError: () => void qc.invalidateQueries({ queryKey: key }),
  })
  const onMove = (m: TaskMove) => {
    // Without a rank (the card menu) the card goes to the end of the column.
    const column = (tasks ?? [])
      .filter((x) => x.status.id === m.status.id && x.id !== m.task.id)
      .sort(byRank)
      .map((x) => x.rank)
    move.mutate({ ...m, rank: m.rank ?? rankAt(column, column.length) })
  }
  const quickAdd = async (status: WorkflowStatus, title: string) => {
    const created = await api.createTask(orgId, project.id, { title, statusId: status.id })
    taskSaved(qc, orgId, created)
  }
  const setView = (v: View) =>
    setParams((p) => {
      if (v === 'board') p.delete('view')
      else p.set('view', v)
      return p
    })
  const views: { key: View; icon: typeof KanbanIcon; label: MessageKey }[] = [
    { key: 'board', icon: KanbanIcon, label: 'tasks.view.board' },
    { key: 'list', icon: ListIcon, label: 'tasks.view.list' },
    { key: 'calendar', icon: CalendarDaysIcon, label: 'tasks.view.calendar' },
  ]

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 py-3">
          <TaskFilters project={project} filter={filter} onChange={setFilter} />
          <div className="ml-auto flex items-center gap-2">
            <div role="group" aria-label={t('tasks.views')} className="flex rounded-lg border p-0.5">
              {views.map((v) => (
                <Tooltip key={v.key} content={t(v.label)} side="bottom">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(v.label)}
                    aria-pressed={view === v.key}
                    className={cn(view === v.key && 'bg-primary-soft text-primary hover:bg-primary-soft')}
                    onClick={() => setView(v.key)}
                  >
                    <v.icon />
                  </Button>
                </Tooltip>
              ))}
            </div>
            {project.canEdit && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <PlusIcon />
                {t('tasks.add')}
              </Button>
            )}
            <Tooltip content={asideOpen ? t('projects.hideAbout') : t('projects.showAbout')} side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={asideOpen ? t('projects.hideAbout') : t('projects.showAbout')}
                aria-pressed={asideOpen}
                onClick={() => setAsideOpen(!asideOpen)}
              >
                {asideOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
              </Button>
            </Tooltip>
          </div>
        </div>
        {move.error && (
          <div className="px-6 pb-2">
            <Alert variant="error">{errorMessage(move.error)}</Alert>
          </div>
        )}
        {project.status === 'archived' && (
          <p className="mx-6 mb-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {t('projects.archivedBanner')}
          </p>
        )}
        {project.role === '' && project.status === 'active' && (
          <p className="mx-6 mb-3 text-[13px] text-muted-foreground">{t('projects.viewerHint')}</p>
        )}
        {!tasks ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner label={t('common.loading')} />
          </div>
        ) : view === 'board' ? (
          <TaskBoard project={project} tasks={shown} onOpen={onOpen} onMove={onMove} onQuickAdd={quickAdd} />
        ) : view === 'list' ? (
          <TaskList project={project} tasks={shown} onOpen={onOpen} />
        ) : (
          <TaskCalendar tasks={shown} onOpen={onOpen} />
        )}
      </div>
      {asideOpen && <ProjectAside project={project} tasks={tasks ?? []} onOpen={onOpen} />}
      {project.canEdit && <CreateTaskDialog project={project} open={creating} onOpenChange={setCreating} onCreated={onOpen} />}
    </div>
  )
}
