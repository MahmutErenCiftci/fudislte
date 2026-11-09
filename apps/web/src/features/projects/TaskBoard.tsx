import {
  type Announcements,
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DraggableAttributes,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ProjectDetail, Task, WorkflowStatus } from '@fudislte/api-client'
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Input,
} from '@fudislte/ui'
import { CircleCheckIcon, EllipsisIcon, GripVerticalIcon, MessageSquareIcon, PlusIcon } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../i18n'
import { columns as toColumns } from './filters'
import { Assignees, ChecklistProgress, DueDate, LabelChip, PriorityBadge, StatusDot } from './projects'
import { rankAt } from './rank'

export interface TaskMove {
  task: Task
  status: WorkflowStatus
  /** Undefined: the end of the column. */
  rank?: string
}

/**
 * The Kanban board: one column per status. Cards move with the mouse or the keyboard
 * (focus the handle, Space to pick up, arrows, Space to drop) and through each card's
 * menu; the new rank is computed here so only the moved card changes.
 */
export function TaskBoard({
  project,
  tasks,
  onOpen,
  onMove,
  onQuickAdd,
}: {
  project: ProjectDetail
  tasks: Task[]
  onOpen: (task: Task) => void
  onMove: (move: TaskMove) => void
  onQuickAdd: (status: WorkflowStatus, title: string) => Promise<unknown>
}) {
  const t = useT()
  const cols = useMemo(() => toColumns(project.statuses, tasks), [project.statuses, tasks])
  const byId = useMemo(() => new Map(tasks.map((x) => [x.id, x])), [tasks])
  const statusById = useMemo(() => new Map(project.statuses.map((s) => [s.id, s])), [project.statuses])
  const order = (list: typeof cols) => Object.fromEntries(list.map((c) => [c.status.id, c.tasks.map((x) => x.id)]))
  const [items, setItems] = useState<Record<string, string[]>>(() => order(cols))
  const [activeId, setActiveId] = useState<string | null>(null)
  const snapshot = useRef<Record<string, string[]>>({})
  const dragging = useRef(false)
  const editable = project.canEdit

  // The server's order whenever the tasks change, except while a card is being dragged.
  // A drop keeps its local order until the moved task arrives in the cache.
  useEffect(() => {
    if (!dragging.current) setItems(order(cols))
  }, [cols])
  const finish = (keep?: Record<string, string[]>) => {
    dragging.current = false
    setItems(keep ?? order(cols))
    setActiveId(null)
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const containerOf = (id: string) => (id in items ? id : Object.keys(items).find((k) => items[k]?.includes(id)))
  const where = (id: string) => {
    const col = containerOf(id)
    return { status: col ? statusById.get(col)?.name ?? '' : '', position: col ? (items[col]?.indexOf(id) ?? 0) + 1 : 0 }
  }
  const title = (id: string | number) => byId.get(String(id))?.title ?? ''
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('tasks.dnd.picked', { title: title(active.id), ...where(String(active.id)) }),
    onDragOver: ({ active, over }) => (over ? t('tasks.dnd.over', { title: title(active.id), ...where(String(active.id)) }) : undefined),
    onDragEnd: ({ active, over }) =>
      over ? t('tasks.dnd.dropped', { title: title(active.id), ...where(String(active.id)) }) : t('tasks.dnd.cancelled', { title: title(active.id) }),
    onDragCancel: ({ active }) => t('tasks.dnd.cancelled', { title: title(active.id) }),
  }

  const onDragStart = ({ active }: DragStartEvent) => {
    snapshot.current = items
    dragging.current = true
    setActiveId(String(active.id))
  }
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return
    const from = containerOf(String(active.id))
    const to = containerOf(String(over.id))
    if (!from || !to || from === to) return
    setItems((prev) => {
      const target = prev[to] ?? []
      const overIndex = target.indexOf(String(over.id))
      const index = overIndex >= 0 ? overIndex : target.length
      return {
        ...prev,
        [from]: (prev[from] ?? []).filter((id) => id !== active.id),
        [to]: [...target.slice(0, index), String(active.id), ...target.slice(index)],
      }
    })
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id)
    const col = containerOf(id)
    const task = byId.get(id)
    if (!over || !col || !task) return finish()
    let list = items[col] ?? []
    if (containerOf(String(over.id)) === col && over.id !== col) {
      const from = list.indexOf(id)
      const to = list.indexOf(String(over.id))
      if (from !== to && to >= 0) list = arrayMove(list, from, to)
    }
    const index = list.indexOf(id)
    const before = snapshot.current[task.status.id] ?? []
    const status = statusById.get(col)
    if (!status || (col === task.status.id && before.indexOf(id) === index)) return finish()
    finish({ ...items, [col]: list })
    const others = list.filter((x) => x !== id).map((x) => byId.get(x)?.rank ?? '')
    onMove({ task, status, rank: rankAt(others, index) })
  }

  const board = (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-4">
      {cols.map(({ status }) => (
        <Column
          key={status.id}
          status={status}
          ids={items[status.id] ?? []}
          byId={byId}
          editable={editable}
          statuses={project.statuses}
          onOpen={onOpen}
          onMove={onMove}
          onQuickAdd={onQuickAdd}
        />
      ))}
    </div>
  )
  if (!editable) return board
  const active = activeId ? byId.get(activeId) : undefined
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => finish()}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t('tasks.dnd.instructions') } }}
    >
      {board}
      <DragOverlay>{active ? <TaskCard task={active} overlay /> : null}</DragOverlay>
    </DndContext>
  )
}

function Column({
  status,
  ids,
  byId,
  editable,
  statuses,
  onOpen,
  onMove,
  onQuickAdd,
}: {
  status: WorkflowStatus
  ids: string[]
  byId: Map<string, Task>
  editable: boolean
  statuses: WorkflowStatus[]
  onOpen: (task: Task) => void
  onMove: (move: TaskMove) => void
  onQuickAdd: (status: WorkflowStatus, title: string) => Promise<unknown>
}) {
  const t = useT()
  const { setNodeRef, isOver } = useDroppable({ id: status.id, disabled: !editable })
  const [adding, setAdding] = useState(false)
  const tasks = ids.map((id) => byId.get(id)).filter((x): x is Task => !!x)
  return (
    <section
      aria-label={status.name}
      className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-muted/60 dark:bg-muted/40', isOver && 'ring-2 ring-primary/40')}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <StatusDot color={status.color} />
        <h3 className="truncate text-[14px] font-semibold">{status.name}</h3>
        <span className="rounded-full bg-background px-1.5 text-xs font-medium text-muted-foreground">{tasks.length}</span>
        {editable && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={t('tasks.addTo', { status: status.name })}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
          </Button>
        )}
      </header>
      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {adding && <QuickAdd status={status} onDone={() => setAdding(false)} onAdd={onQuickAdd} />}
        <SortableContext id={status.id} items={ids} strategy={verticalListSortingStrategy}>
          {tasks.map((task) =>
            editable ? (
              <SortableCard key={task.id} task={task} statuses={statuses} onOpen={onOpen} onMove={onMove} />
            ) : (
              <TaskCard key={task.id} task={task} onOpen={onOpen} />
            ),
          )}
        </SortableContext>
        {tasks.length === 0 && !adding && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('tasks.emptyColumn')}</p>}
      </div>
    </section>
  )
}

function QuickAdd({
  status,
  onAdd,
  onDone,
}: {
  status: WorkflowStatus
  onAdd: (status: WorkflowStatus, title: string) => Promise<unknown>
  onDone: () => void
}) {
  const t = useT()
  const [title, setTitle] = useState('')
  const [pending, setPending] = useState(false)
  const submit = async () => {
    if (!title.trim()) return onDone()
    setPending(true)
    try {
      await onAdd(status, title)
      setTitle('')
    } finally {
      setPending(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
    if (e.key === 'Escape') onDone()
  }
  return (
    <Input
      autoFocus
      maxLength={200}
      disabled={pending}
      aria-label={t('tasks.quickAdd', { status: status.name })}
      placeholder={t('tasks.quickAddPlaceholder')}
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => !title.trim() && onDone()}
      className="bg-card"
    />
  )
}

function SortableCard({
  task,
  statuses,
  onOpen,
  onMove,
}: {
  task: Task
  statuses: WorkflowStatus[]
  onOpen: (task: Task) => void
  onMove: (move: TaskMove) => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'opacity-40')}
      {...listeners}
    >
      <TaskCard
        task={task}
        onOpen={onOpen}
        handle={{ ref: setActivatorNodeRef, props: attributes }}
        menu={<MoveMenu task={task} statuses={statuses} onMove={onMove} />}
      />
    </div>
  )
}

/** Moves a card to another column without dragging. */
function MoveMenu({ task, statuses, onMove }: { task: Task; statuses: WorkflowStatus[]; onMove: (move: TaskMove) => void }) {
  const t = useT()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="-mr-1 -mt-1 shrink-0" aria-label={t('tasks.cardMenu', { title: task.title })}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('tasks.moveTo')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={task.status.id}
          onValueChange={(id) => {
            const status = statuses.find((s) => s.id === id)
            if (status && id !== task.status.id) onMove({ task, status })
          }}
        >
          {statuses.map((s) => (
            <DropdownMenuRadioItem key={s.id} value={s.id}>
              <StatusDot color={s.color} />
              {s.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TaskCard({
  task,
  onOpen,
  overlay,
  handle,
  menu,
}: {
  task: Task
  onOpen?: (task: Task) => void
  overlay?: boolean
  handle?: { ref: (el: HTMLElement | null) => void; props: DraggableAttributes }
  menu?: ReactNode
}) {
  const t = useT()
  const done = task.status.category === 'done'
  return (
    <article
      className={cn(
        'group rounded-lg border bg-card p-3 shadow-[var(--shadow-panel)] transition-colors hover:border-primary/40',
        overlay && 'rotate-2 cursor-grabbing shadow-lg',
      )}
    >
      <div className="flex items-start gap-1.5">
        {handle && (
          <button
            ref={handle.ref}
            type="button"
            {...handle.props}
            aria-label={t('tasks.dragHandle', { title: task.title })}
            className="-ml-1.5 mt-0.5 flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/50 outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpen?.(task)}
          className="min-w-0 flex-1 rounded text-left text-[13px] leading-5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className={cn(done && 'text-muted-foreground')}>{task.title}</span>
        </button>
        {menu}
      </div>
      {task.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{task.key}</span>
        <PriorityBadge priority={task.priority} />
        <DueDate task={task} />
        <ChecklistProgress done={task.checklist.done} total={task.checklist.total} />
        {task.commentCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={t('tasks.comments')}>
            <MessageSquareIcon className="size-3.5" />
            {task.commentCount}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Assignees people={task.assignees} />
          {done && <CircleCheckIcon className="size-4 text-success" aria-label={t('tasks.done')} />}
        </span>
      </div>
    </article>
  )
}
