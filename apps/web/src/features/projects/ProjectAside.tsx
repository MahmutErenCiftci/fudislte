import type { ProjectDetail, Task } from '@fudislte/api-client'
import { Avatar, Badge, cn, Spinner } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { CalendarIcon, CircleDotIcon, TagIcon, UsersIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useT } from '../../i18n'
import { api, queryKeys } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { useWorkspace } from '../../shell/context'
import { describeActivity } from './activity'
import { formatDueDate, LabelChip } from './projects'

/** The side panel of the tasks tab: "Proje Hakkında" and the project's activity. */
export function ProjectAside({ project, tasks, onOpen }: { project: ProjectDetail; tasks: Task[]; onOpen: (task: Task) => void }) {
  const t = useT()
  const [tab, setTab] = useState<'details' | 'activity'>('details')
  return (
    <aside aria-label={t('projects.about')} className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l lg:flex">
      <nav className="flex shrink-0 gap-1 border-b px-4">
        {(['details', 'activity'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-current={tab === k ? 'page' : undefined}
            onClick={() => setTab(k)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2.5 text-[13px] font-medium outline-none focus-visible:text-foreground',
              tab === k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {k === 'details' ? t('projects.details') : t('projects.activity')}
          </button>
        ))}
      </nav>
      {tab === 'details' ? <Details project={project} tasks={tasks} /> : <ActivityFeed project={project} tasks={tasks} onOpen={onOpen} />}
    </aside>
  )
}

function Details({ project, tasks }: { project: ProjectDetail; tasks: Task[] }) {
  const t = useT()
  const done = tasks.filter((x) => x.status.category === 'done').length
  return (
    <div className="grid gap-5 p-4">
      <section>
        <h2 className="text-[15px] font-semibold">{t('projects.about')}</h2>
        <p className="mt-2 text-[13px] whitespace-pre-line text-muted-foreground">{project.description || t('projects.noDescription')}</p>
      </section>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 text-[13px]">
        <Row icon={<CalendarIcon />} label={t('projects.startsOn')}>
          {project.startsOn ? formatDueDate(project.startsOn, true) : '—'}
        </Row>
        <Row icon={<CalendarIcon />} label={t('projects.endsOn')}>
          {project.endsOn ? formatDueDate(project.endsOn, true) : '—'}
        </Row>
        <Row icon={<CircleDotIcon />} label={t('projects.status')}>
          <Badge variant={project.status === 'active' ? 'success' : 'amber'}>
            {project.status === 'active' ? t('projects.active') : t('projects.archived')}
          </Badge>
        </Row>
        <Row icon={<UsersIcon />} label={t('projects.team')}>
          <span className="flex flex-wrap gap-1">
            {project.members.slice(0, 8).map((m) => (
              <Avatar key={m.user.id} name={m.user.displayName} seed={m.user.id} size="sm" title={m.user.displayName} />
            ))}
            {project.members.length > 8 && <span className="self-center text-xs text-muted-foreground">+{project.members.length - 8}</span>}
          </span>
        </Row>
        <Row icon={<TagIcon />} label={t('tasks.labels')}>
          <span className="flex flex-wrap gap-1">
            {project.labels.length === 0 ? '—' : project.labels.map((l) => <LabelChip key={l.id} label={l} />)}
          </span>
        </Row>
      </dl>
      <section className="rounded-xl border p-3">
        <p className="text-xs text-muted-foreground">{t('projects.progress', { done, total: tasks.length })}</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
          <div className="h-full rounded-full bg-primary" style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
        </div>
      </section>
    </div>
  )
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function ActivityFeed({ project, tasks, onOpen }: { project: ProjectDetail; tasks: Task[]; onOpen: (task: Task) => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const events = useQuery({
    queryKey: queryKeys.projectActivity(orgId, project.id),
    queryFn: () => api.projectActivity(orgId, project.id),
  })
  if (events.isPending) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    )
  }
  return (
    <ul className="grid gap-4 p-4">
      {events.data?.length === 0 && <li className="text-[13px] text-muted-foreground">{t('projects.noActivity')}</li>}
      {events.data?.map((e) => {
        const task = e.task ? tasks.find((x) => x.id === e.task?.id) : undefined
        return (
          <li key={e.id} className="flex gap-2.5 text-[13px]">
            <Avatar name={e.actor?.displayName ?? '?'} seed={e.actor?.id} size="sm" />
            <div className="min-w-0 flex-1">
              <p>
                <span className="font-semibold">{e.actor?.displayName ?? t('audit.deletedUser')}</span>{' '}
                {describeActivity(e, (d) => formatDueDate(d, true))}
              </p>
              {e.task && (
                <button
                  type="button"
                  disabled={!task}
                  onClick={() => task && onOpen(task)}
                  className="mt-0.5 block max-w-full truncate text-left text-xs text-muted-foreground outline-none enabled:hover:text-foreground enabled:hover:underline focus-visible:underline"
                >
                  <span className="font-mono">{e.task.key}</span> · {e.task.title}
                </button>
              )}
              <p className="text-xs text-muted-foreground">{formatRelative(e.createdAt)}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
