import type { Task, TaskPriority, WorkflowStatus } from '@fudislte/api-client'

import { byRank } from './rank'

/** The task filters of a project page ("Tüm görevler", search, labels, assignees, sprint, priority). */
export interface TaskFilter {
  scope: 'all' | 'mine' | 'unassigned'
  query: string
  /** A task matches when it has any of these labels. */
  labelIds: string[]
  /** A task matches when any of these people is assigned. */
  assigneeIds: string[]
  /** '' any sprint, 'backlog' no sprint, otherwise a sprint ID. */
  sprint: string
  priorities: TaskPriority[]
}

export const emptyFilter: TaskFilter = { scope: 'all', query: '', labelIds: [], assigneeIds: [], sprint: '', priorities: [] }

const fold = (s: string) => s.toLocaleLowerCase('tr')

export function matchesFilter(task: Task, f: TaskFilter, meId: string): boolean {
  if (f.scope === 'mine' && !task.assignees.some((p) => p.id === meId)) return false
  if (f.scope === 'unassigned' && task.assignees.length > 0) return false
  const q = fold(f.query.trim())
  if (q && !fold(task.title).includes(q) && !fold(task.key).includes(q)) return false
  if (f.labelIds.length > 0 && !task.labels.some((l) => f.labelIds.includes(l.id))) return false
  if (f.assigneeIds.length > 0 && !task.assignees.some((p) => f.assigneeIds.includes(p.id))) return false
  if (f.sprint === 'backlog' && task.sprintId !== null) return false
  if (f.sprint && f.sprint !== 'backlog' && task.sprintId !== f.sprint) return false
  if (f.priorities.length > 0 && !f.priorities.includes(task.priority)) return false
  return true
}

export function filterTasks(tasks: readonly Task[], f: TaskFilter, meId: string): Task[] {
  return tasks.filter((t) => matchesFilter(t, f, meId))
}

/** How many filters besides the scope are set, for the "clear filters" button. */
export function activeFilters(f: TaskFilter): number {
  return (
    (f.query.trim() ? 1 : 0) + (f.labelIds.length > 0 ? 1 : 0) + (f.assigneeIds.length > 0 ? 1 : 0) + (f.sprint ? 1 : 0) +
    (f.priorities.length > 0 ? 1 : 0) + (f.scope !== 'all' ? 1 : 0)
  )
}

/** The board's columns: each status with its tasks in rank order. */
export function columns(statuses: readonly WorkflowStatus[], tasks: readonly Task[]): { status: WorkflowStatus; tasks: Task[] }[] {
  const byStatus = new Map<string, Task[]>(statuses.map((s) => [s.id, []]))
  for (const t of tasks) byStatus.get(t.status.id)?.push(t)
  return statuses.map((status) => ({ status, tasks: (byStatus.get(status.id) ?? []).sort(byRank) }))
}

export const priorityOrder: TaskPriority[] = ['urgent', 'high', 'medium', 'low', 'none']

/** Today as YYYY-MM-DD in local time. */
export function todayKey(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A task past its due date that is not done. */
export function isOverdue(task: Pick<Task, 'dueOn' | 'status'>, today = todayKey()): boolean {
  return task.dueOn !== null && task.dueOn < today && task.status.category !== 'done'
}

/** List order: open before done, then due date (none last), priority, number. */
export function compareForList(a: Task, b: Task): number {
  const done = Number(a.status.category === 'done') - Number(b.status.category === 'done')
  if (done !== 0) return done
  if (a.dueOn !== b.dueOn) {
    if (a.dueOn === null) return 1
    if (b.dueOn === null) return -1
    return a.dueOn < b.dueOn ? -1 : 1
  }
  const p = priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)
  return p !== 0 ? p : a.number - b.number
}
