import type { ProjectDetail, TaskPriority } from '@fudislte/api-client'
import { Avatar, Button, Checkbox, cn, Input, NativeSelect, Popover, PopoverContent, PopoverTrigger } from '@fudislte/ui'
import { FilterXIcon, type LucideIcon, SearchIcon, StarIcon, TagIcon, TimerIcon, UserIcon } from 'lucide-react'
import { type ReactNode, useId } from 'react'

import { useT } from '../../i18n'
import { activeFilters, emptyFilter, type TaskFilter } from './filters'
import { LabelChip, priorities, priorityLabel } from './projects'

/** The filter bar above the task views (mockup "Yeni 07"). */
export function TaskFilters({
  project,
  filter,
  onChange,
}: {
  project: ProjectDetail
  filter: TaskFilter
  onChange: (f: TaskFilter) => void
}) {
  const t = useT()
  const set = (patch: Partial<TaskFilter>) => onChange({ ...filter, ...patch })
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const sprints = project.sprints.filter((s) => s.state !== 'completed')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={t('tasks.scope')}
        className="h-8 w-auto text-[13px]"
        value={filter.scope}
        onChange={(e) => set({ scope: e.target.value as TaskFilter['scope'] })}
      >
        <option value="all">{t('tasks.scope.all')}</option>
        <option value="mine">{t('tasks.scope.mine')}</option>
        <option value="unassigned">{t('tasks.scope.unassigned')}</option>
      </NativeSelect>
      <Input
        icon={<SearchIcon />}
        aria-label={t('tasks.search')}
        placeholder={t('tasks.search')}
        className="h-8 w-48 text-[13px]"
        value={filter.query}
        onChange={(e) => set({ query: e.target.value })}
      />
      <MultiFilter icon={TagIcon} label={t('tasks.labels')} count={filter.labelIds.length}>
        {project.labels.length === 0 && <p className="text-xs text-muted-foreground">{t('tasks.noLabels')}</p>}
        {project.labels.map((l) => (
          <CheckRow key={l.id} checked={filter.labelIds.includes(l.id)} onChange={() => set({ labelIds: toggle(filter.labelIds, l.id) })}>
            <LabelChip label={l} />
          </CheckRow>
        ))}
      </MultiFilter>
      <MultiFilter icon={UserIcon} label={t('tasks.assignee')} count={filter.assigneeIds.length}>
        {project.members.map((m) => (
          <CheckRow
            key={m.user.id}
            checked={filter.assigneeIds.includes(m.user.id)}
            onChange={() => set({ assigneeIds: toggle(filter.assigneeIds, m.user.id) })}
          >
            <Avatar name={m.user.displayName} seed={m.user.id} size="xs" />
            <span className="truncate">{m.user.displayName}</span>
          </CheckRow>
        ))}
      </MultiFilter>
      <label className="relative">
        <span className="sr-only">{t('tasks.sprint')}</span>
        <TimerIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <NativeSelect className="h-8 w-auto pl-8 text-[13px]" value={filter.sprint} onChange={(e) => set({ sprint: e.target.value })}>
          <option value="">{t('tasks.sprintAny')}</option>
          <option value="backlog">{t('tasks.backlog')}</option>
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.state === 'active' ? ` · ${t('sprints.state.active')}` : ''}
            </option>
          ))}
        </NativeSelect>
      </label>
      <MultiFilter icon={StarIcon} label={t('tasks.priority')} count={filter.priorities.length}>
        {priorities.map((p: TaskPriority) => (
          <CheckRow key={p} checked={filter.priorities.includes(p)} onChange={() => set({ priorities: toggle(filter.priorities, p) })}>
            {t(priorityLabel(p))}
          </CheckRow>
        ))}
      </MultiFilter>
      {activeFilters(filter) > 0 && (
        <Button variant="ghost" size="sm" onClick={() => onChange(emptyFilter)}>
          <FilterXIcon />
          {t('tasks.clearFilters')}
        </Button>
      )}
    </div>
  )
}

function MultiFilter({ icon: Icon, label, count, children }: { icon: LucideIcon; label: string; count: number; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(count > 0 && 'border-primary text-primary')}>
          <Icon />
          {label}
          {count > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">{count}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid max-h-80 w-60 gap-1 overflow-y-auto p-2">
        {children}
      </PopoverContent>
    </Popover>
  )
}

function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  const id = useId()
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      {children}
    </label>
  )
}
