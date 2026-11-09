import type { ProjectDetail, Task } from '@fudislte/api-client'
import { Button, cn } from '@fudislte/ui'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { getLanguage, intlLocale, useT } from '../../i18n'
import { addMonths, dateKey, type Month, monthGrid, monthOf, tasksByDay } from './calendar'
import { compareForList, todayKey } from './filters'
import { Assignees, DueDate, LabelChip, PriorityBadge, StatusDot } from './projects'

/** The list view: one row per task, open ones first, soonest due first. */
export function TaskList({ project, tasks, onOpen }: { project: ProjectDetail; tasks: Task[]; onOpen: (task: Task) => void }) {
  const t = useT()
  const sorted = useMemo(() => [...tasks].sort(compareForList), [tasks])
  const sprintName = (id: string | null) => project.sprints.find((s) => s.id === id)?.name ?? ''
  if (sorted.length === 0) return <p className="px-6 py-10 text-center text-[13px] text-muted-foreground">{t('tasks.noneMatch')}</p>
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
      <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10 bg-card text-left text-xs text-muted-foreground">
          <tr>
            {[t('tasks.colKey'), t('tasks.colTitle'), t('tasks.colStatus'), t('tasks.colAssignees'), t('tasks.colPriority'), t('tasks.colDue'), t('tasks.colSprint')].map(
              (h) => (
                <th key={h} scope="col" className="border-b px-2 py-2 font-medium">
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((task) => (
            <tr key={task.id} className="hover:bg-accent/50">
              <td className="border-b px-2 py-2 font-mono text-xs text-muted-foreground">{task.key}</td>
              <td className="border-b px-2 py-2">
                <button
                  type="button"
                  onClick={() => onOpen(task)}
                  className={cn(
                    'rounded text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50',
                    task.status.category === 'done' && 'text-muted-foreground line-through',
                  )}
                >
                  {task.title}
                </button>
                {task.labels.length > 0 && (
                  <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                    {task.labels.map((l) => (
                      <LabelChip key={l.id} label={l} />
                    ))}
                  </span>
                )}
              </td>
              <td className="border-b px-2 py-2">
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <StatusDot color={task.status.color} />
                  {task.status.name}
                </span>
              </td>
              <td className="border-b px-2 py-2">
                <Assignees people={task.assignees} />
              </td>
              <td className="border-b px-2 py-2">
                <PriorityBadge priority={task.priority} />
              </td>
              <td className="border-b px-2 py-2 whitespace-nowrap">
                <DueDate task={task} />
              </td>
              <td className="border-b px-2 py-2 text-muted-foreground">{sprintName(task.sprintId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The calendar view: a month grid with tasks on their due dates. */
export function TaskCalendar({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  const t = useT()
  const [month, setMonth] = useState<Month>(() => monthOf(new Date()))
  const language = getLanguage()
  const weekStart = language === 'tr' ? 1 : 0
  const days = monthGrid(month, weekStart)
  const byDay = useMemo(() => tasksByDay(tasks), [tasks])
  const undated = tasks.filter((x) => !x.dueOn).length
  const today = todayKey()
  const title = new Intl.DateTimeFormat(intlLocale[language], { month: 'long', year: 'numeric' }).format(new Date(month.year, month.month, 1))
  const weekdays = days.slice(0, 7).map((d) => new Intl.DateTimeFormat(intlLocale[language], { weekday: 'short' }).format(d))

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[15px] font-semibold capitalize">{title}</h3>
        <Button variant="outline" size="icon-sm" aria-label={t('tasks.prevMonth')} onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeftIcon />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label={t('tasks.nextMonth')} onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRightIcon />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setMonth(monthOf(new Date()))}>
          {t('tasks.thisMonth')}
        </Button>
        {undated > 0 && <span className="ml-auto text-xs text-muted-foreground">{t('tasks.undated', { count: undated })}</span>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(5.5rem,1fr))] overflow-auto rounded-xl border">
        {weekdays.map((w) => (
          <div key={w} className="border-b bg-muted/50 px-2 py-1.5 text-xs font-medium text-muted-foreground capitalize">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = dateKey(d)
          const list = byDay.get(key) ?? []
          const outside = d.getMonth() !== month.month
          return (
            <div key={key} className={cn('min-w-0 border-b border-l p-1 first:border-l-0 [&:nth-child(7n+1)]:border-l-0', outside && 'bg-muted/30')}>
              <span
                className={cn(
                  'mb-1 inline-flex size-6 items-center justify-center rounded-full text-xs',
                  key === today ? 'bg-primary font-semibold text-primary-foreground' : outside ? 'text-muted-foreground/60' : 'text-muted-foreground',
                )}
              >
                {d.getDate()}
              </span>
              <ul className="grid gap-1">
                {list.slice(0, 3).map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(task)}
                      className={cn(
                        'flex w-full items-center gap-1.5 truncate rounded-md border bg-card px-1.5 py-0.5 text-left text-xs outline-none hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/50',
                        task.status.category === 'done' && 'text-muted-foreground line-through',
                      )}
                    >
                      <StatusDot color={task.status.color} className="size-2" />
                      <span className="truncate">{task.title}</span>
                    </button>
                  </li>
                ))}
                {list.length > 3 && <li className="px-1.5 text-[11px] text-muted-foreground">{t('tasks.more', { count: list.length - 3 })}</li>}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A compact row for task lists outside a project page (my tasks, a room's linked tasks). */
export function TaskRow({ task, onOpen, showProject = true }: { task: Task; onOpen: () => void; showProject?: boolean }) {
  const done = task.status.category === 'done'
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-5 py-3 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent/60"
    >
      <StatusDot color={task.status.color} />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[14px] font-medium', done && 'text-muted-foreground line-through')}>{task.title}</span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{task.key}</span>
          {showProject && <span className="truncate">{task.project.name}</span>}
          <span>{task.status.name}</span>
          <DueDate task={task} />
        </span>
      </span>
      <PriorityBadge priority={task.priority} />
      <Assignees people={task.assignees} />
    </button>
  )
}
