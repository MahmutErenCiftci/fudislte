import type { Person, Project, ProjectColor, ProjectLabel, StatusCategory, Task, TaskPriority } from '@fudislte/api-client'
import { Avatar, Badge, type BadgeVariant, cn } from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  ChevronsUpIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  EqualIcon,
  EyeIcon,
  type LucideIcon,
} from 'lucide-react'

import { getLanguage, intlLocale, type MessageKey, useT } from '../../i18n'
import { api, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { taskSaved } from './cache'
import { isOverdue } from './filters'

/** Projects the caller may see; project.updated events refetch them. */
export function useProjects(archived = false, enabled = true) {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  return useQuery({ queryKey: queryKeys.projectList(orgId, archived), queryFn: () => api.projects(orgId, archived), enabled })
}

export function useProject(projectId: string) {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  return useQuery({ queryKey: queryKeys.project(orgId, projectId), queryFn: () => api.project(orgId, projectId) })
}

/** A project's tasks, kept current by task.updated events. */
export function useProjectTasks(projectId: string, enabled = true) {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  return useQuery({
    queryKey: queryKeys.projectTasks(orgId, projectId),
    queryFn: () => api.tasks(orgId, projectId),
    enabled,
    staleTime: Infinity, // live events keep it current; reconnects refetch
  })
}

/** The caller's assigned tasks across projects. */
export function useMyTasks() {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  return useQuery({ queryKey: queryKeys.myTasks(orgId), queryFn: () => api.myTasks(orgId) })
}

/**
 * Ticks a task off where it is listed outside its project (a room, the home page): it
 * moves to the project's first done status, or back to its first open one.
 */
export function useToggleDone() {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (task: Task) => {
      const project = await qc.fetchQuery({ queryKey: queryKeys.project(orgId, task.project.id), queryFn: () => api.project(orgId, task.project.id) })
      const done = task.status.category === 'done'
      const target = project.statuses.find((s) => (s.category === 'done') !== done)
      return target ? api.updateTask(orgId, task.project.id, task.id, { statusId: target.id }) : null
    },
    onSuccess: (saved) => saved && taskSaved(qc, orgId, saved),
  })
}

/** Where a project, or one of its tasks, opens. */
export function useProjectLinks() {
  const { workspace } = useWorkspace()
  const root = `/w/${workspace.organization.slug}`
  return {
    project: (projectId: string, tab?: string) => `${root}/p/${projectId}${tab ? `?tab=${tab}` : ''}`,
    task: (projectId: string, taskId: string) => `${root}/p/${projectId}?task=${taskId}`,
  }
}

export const projectColors: ProjectColor[] = ['blue', 'indigo', 'violet', 'pink', 'red', 'orange', 'amber', 'green', 'emerald', 'teal', 'sky', 'slate']

/** Solid dots and swatches. */
export const colorDot: Record<ProjectColor, string> = {
  slate: 'bg-slate-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  emerald: 'bg-emerald-500',
  teal: 'bg-teal-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
}

/** Soft background with strong text: labels and project tiles. */
export const colorSoft: Record<ProjectColor, string> = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  orange: 'bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  green: 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  teal: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  sky: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  pink: 'bg-pink-50 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
}

/** The project's tile: its key's first letters on its colour. */
export function ProjectIcon({ project, size = 'md' }: { project: Pick<Project, 'key' | 'color'>; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl font-bold tracking-tight',
        colorSoft[project.color],
        size === 'sm' && 'size-7 rounded-lg text-[10px]',
        size === 'md' && 'size-11 text-[13px]',
        size === 'lg' && 'size-14 rounded-2xl text-base',
      )}
    >
      {project.key.slice(0, 3)}
    </span>
  )
}

export function LabelChip({ label, className }: { label: Pick<ProjectLabel, 'name' | 'color'>; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full items-center truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium', colorSoft[label.color], className)}>
      {label.name}
    </span>
  )
}

export const categoryIcons: Record<StatusCategory, LucideIcon> = {
  todo: CircleDashedIcon,
  in_progress: CircleDotIcon,
  review: EyeIcon,
  done: CircleCheckIcon,
}

export function StatusDot({ color, className }: { color: ProjectColor; className?: string }) {
  return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', colorDot[color], className)} />
}

export const priorities: TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent']

const priorityStyle: Record<Exclude<TaskPriority, 'none'>, { icon: LucideIcon; variant: BadgeVariant }> = {
  low: { icon: ArrowDownIcon, variant: 'slate' },
  medium: { icon: EqualIcon, variant: 'primary' },
  high: { icon: ArrowUpIcon, variant: 'amber' },
  urgent: { icon: ChevronsUpIcon, variant: 'destructive' },
}

export const priorityLabel = (p: TaskPriority): MessageKey => `tasks.priority.${p}`

/** "Yüksek" with an arrow; nothing for tasks without a priority. */
export function PriorityBadge({ priority, className }: { priority: TaskPriority; className?: string }) {
  const t = useT()
  if (priority === 'none') return null
  const style = priorityStyle[priority]
  return (
    <Badge variant={style.variant} className={className}>
      <style.icon />
      {t(priorityLabel(priority))}
    </Badge>
  )
}

/** A due date as a calendar date in local time ("12 Eki"). */
export function formatDueDate(dueOn: string, withYear = false): string {
  const [y, m, d] = dueOn.split('-').map(Number)
  return new Intl.DateTimeFormat(intlLocale[getLanguage()], {
    day: 'numeric',
    month: 'short',
    ...(withYear && { year: 'numeric' }),
  }).format(new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1))
}

/** The due date of a card, red when overdue. */
export function DueDate({ task, className }: { task: Pick<Task, 'dueOn' | 'status'>; className?: string }) {
  const t = useT()
  if (!task.dueOn) return null
  const late = isOverdue(task)
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs', late ? 'font-medium text-destructive' : 'text-muted-foreground', className)}
      title={late ? t('tasks.overdue') : t('tasks.due')}
    >
      <CalendarIcon className="size-3.5" />
      {formatDueDate(task.dueOn)}
    </span>
  )
}

/** Overlapping avatars for a task's assignees, then "+N". */
export function Assignees({ people, max = 3 }: { people: Person[]; max?: number }) {
  if (people.length === 0) return null
  return (
    <span className="flex items-center -space-x-1.5">
      {people.slice(0, max).map((p) => (
        <Avatar key={p.id} name={p.displayName} seed={p.id} size="xs" className="ring-2 ring-card" />
      ))}
      {people.length > max && (
        <span className="relative flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-card">
          +{people.length - max}
        </span>
      )}
    </span>
  )
}

/** "3/5" with a ring for a task's checklist. */
export function ChecklistProgress({ done, total }: { done: number; total: number }) {
  const t = useT()
  if (total === 0) return null
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={t('tasks.checklist')}>
      <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden="true">
        <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-muted" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={`${(c * done) / total} ${c}`}
        />
      </svg>
      {done}/{total}
    </span>
  )
}
