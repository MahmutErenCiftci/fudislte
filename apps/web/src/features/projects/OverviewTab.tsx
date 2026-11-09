import type { ProjectDetail, Task } from '@fudislte/api-client'
import { Avatar } from '@fudislte/ui'
import { AlarmClockIcon, CircleCheckIcon, ListTodoIcon, type LucideIcon, TimerIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { useT } from '../../i18n'
import { compareForList, isOverdue, priorityOrder, todayKey } from './filters'
import { colorDot, formatDueDate, PriorityBadge, priorityLabel } from './projects'
import { TaskRow } from './TaskViews'

/** "Genel Bakış": where the project stands, computed from its tasks. */
export function OverviewTab({ project, tasks, onOpen }: { project: ProjectDetail; tasks: Task[]; onOpen: (task: Task) => void }) {
  const t = useT()
  const today = todayKey()
  const open = tasks.filter((x) => x.status.category !== 'done')
  const done = tasks.length - open.length
  const overdue = open.filter((x) => isOverdue(x, today)).sort(compareForList)
  const weekAhead = todayKey(new Date(Date.now() + 7 * 86_400_000))
  const upcoming = open.filter((x) => x.dueOn && x.dueOn >= today && x.dueOn <= weekAhead).sort(compareForList)
  const active = project.sprints.find((s) => s.state === 'active')
  const sprintTasks = active ? tasks.filter((x) => x.sprintId === active.id) : []
  const sprintDone = sprintTasks.filter((x) => x.status.category === 'done').length
  const max = Math.max(1, ...project.statuses.map((s) => tasks.filter((x) => x.status.id === s.id).length))
  const workload = project.members
    .map((m) => ({ person: m.user, count: open.filter((x) => x.assignees.some((p) => p.id === m.user.id)).length }))
    .filter((w) => w.count > 0)
    .sort((a, b) => b.count - a.count)
  const unassigned = open.filter((x) => x.assignees.length === 0).length

  return (
    <div className="grid content-start gap-5 overflow-y-auto p-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={ListTodoIcon} label={t('overview.total')} value={tasks.length} />
        <Stat icon={TimerIcon} label={t('overview.open')} value={open.length} />
        <Stat icon={CircleCheckIcon} label={t('overview.done')} value={done} tone="text-success" />
        <Stat icon={AlarmClockIcon} label={t('overview.overdue')} value={overdue.length} tone={overdue.length ? 'text-destructive' : undefined} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title={t('overview.byStatus')}>
          <ul className="grid gap-3 p-4">
            {project.statuses.map((s) => {
              const n = tasks.filter((x) => x.status.id === s.id).length
              return (
                <li key={s.id} className="grid grid-cols-[8rem_1fr_2rem] items-center gap-3 text-[13px]">
                  <span className="truncate">{s.name}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-muted" role="presentation">
                    <span className={`block h-full rounded-full ${colorDot[s.color]}`} style={{ width: `${(n / max) * 100}%` }} />
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">{n}</span>
                </li>
              )
            })}
          </ul>
        </Card>
        <Card title={active ? t('overview.activeSprint', { name: active.name }) : t('overview.noActiveSprint')}>
          {active ? (
            <div className="grid gap-3 p-4 text-[13px]">
              {active.goal && <p className="text-muted-foreground">{active.goal}</p>}
              <p className="text-xs text-muted-foreground">
                {active.startsOn ? formatDueDate(active.startsOn, true) : '…'} – {active.endsOn ? formatDueDate(active.endsOn, true) : '…'}
              </p>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('projects.progress', { done: sprintDone, total: sprintTasks.length })}</p>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="presentation">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${sprintTasks.length ? (sprintDone / sprintTasks.length) * 100 : 0}%` }} />
                </div>
              </div>
            </div>
          ) : (
            <p className="p-4 text-[13px] text-muted-foreground">{t('overview.noActiveSprintHint')}</p>
          )}
        </Card>
        <Card title={t('overview.byPriority')}>
          <ul className="flex flex-wrap gap-3 p-4">
            {priorityOrder.map((p) => (
              <li key={p} className="flex items-center gap-2 text-[13px]">
                {p === 'none' ? <span className="text-muted-foreground">{t(priorityLabel(p))}</span> : <PriorityBadge priority={p} />}
                <span className="tabular-nums">{open.filter((x) => x.priority === p).length}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t('overview.workload')}>
          <ul className="divide-y">
            {workload.map((w) => (
              <li key={w.person.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <Avatar name={w.person.displayName} seed={w.person.id} size="sm" />
                <span className="min-w-0 flex-1 truncate">{w.person.displayName}</span>
                <span className="text-muted-foreground">{t('overview.openTasks', { count: w.count })}</span>
              </li>
            ))}
            {unassigned > 0 && (
              <li className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-muted-foreground">
                <span className="flex-1">{t('tasks.unassigned')}</span>
                {t('overview.openTasks', { count: unassigned })}
              </li>
            )}
            {workload.length === 0 && unassigned === 0 && <li className="px-4 py-3 text-[13px] text-muted-foreground">{t('overview.nothingOpen')}</li>}
          </ul>
        </Card>
        <Card title={t('overview.overdueList')}>
          <TaskRows tasks={overdue} onOpen={onOpen} empty={t('overview.noneOverdue')} />
        </Card>
        <Card title={t('overview.dueSoon')}>
          <TaskRows tasks={upcoming} onOpen={onOpen} empty={t('overview.noneDueSoon')} />
        </Card>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
      <span className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary">
        <Icon className="size-5" />
      </span>
      <div>
        <p className={`text-2xl font-bold tabular-nums ${tone ?? ''}`}>{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <h2 className="border-b px-4 py-3 text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function TaskRows({ tasks, onOpen, empty }: { tasks: Task[]; onOpen: (task: Task) => void; empty: string }) {
  if (tasks.length === 0) return <p className="px-4 py-3 text-[13px] text-muted-foreground">{empty}</p>
  return (
    <ul className="divide-y">
      {tasks.slice(0, 8).map((task) => (
        <li key={task.id}>
          <TaskRow task={task} onOpen={() => onOpen(task)} showProject={false} />
        </li>
      ))}
    </ul>
  )
}
