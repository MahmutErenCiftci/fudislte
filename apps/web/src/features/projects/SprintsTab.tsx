import type { ProjectDetail, Sprint, SprintInput, Task } from '@fudislte/api-client'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  Textarea,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleCheckBigIcon, KanbanIcon, PencilIcon, PlayIcon, PlusIcon, TimerIcon, Trash2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { ConfirmDialog } from '../chat/ChannelDialogs'
import { taskSaved } from './cache'
import { compareForList } from './filters'
import { formatDueDate } from './projects'
import { TaskRow } from './TaskViews'

/**
 * "Sprintler": the active sprint, planned ones and the backlog. Tasks move between
 * sprints with the select on each row; completing a sprint returns unfinished tasks to
 * the backlog.
 */
export function SprintsTab({
  project,
  tasks,
  onOpen,
  onShowBoard,
}: {
  project: ProjectDetail
  tasks: Task[]
  onOpen: (task: Task) => void
  onShowBoard: (sprintId: string) => void
}) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Sprint | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Sprint | null>(null)
  const [completing, setCompleting] = useState<Sprint | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.project(orgId, project.id) })
    void qc.invalidateQueries({ queryKey: queryKeys.projectTasks(orgId, project.id) })
  }
  const action = useMutation({
    mutationFn: ({ sprint, kind }: { sprint: Sprint; kind: 'start' | 'complete' | 'delete' }): Promise<unknown> =>
      kind === 'start'
        ? api.startSprint(orgId, project.id, sprint.id)
        : kind === 'complete'
          ? api.completeSprint(orgId, project.id, sprint.id)
          : api.deleteSprint(orgId, project.id, sprint.id),
    onSuccess: () => {
      refresh()
      setDeleting(null)
      setCompleting(null)
    },
  })
  const assign = useMutation({
    mutationFn: ({ task, sprintId }: { task: Task; sprintId: string | null }) => api.updateTask(orgId, project.id, task.id, { sprintId }),
    onSuccess: (saved) => taskSaved(qc, orgId, saved),
  })
  const open = project.sprints.filter((s) => s.state !== 'completed')
  const completed = project.sprints.filter((s) => s.state === 'completed')
  const backlog = tasks.filter((x) => x.sprintId === null && x.status.category !== 'done').sort(compareForList)
  const manage = project.canManage && project.status === 'active'

  const row = (task: Task) => (
    <li key={task.id} className="flex items-center gap-2 pr-4">
      <div className="min-w-0 flex-1">
        <TaskRow task={task} onOpen={() => onOpen(task)} showProject={false} />
      </div>
      {project.canEdit && (
        <NativeSelect
          aria-label={t('sprints.moveTask', { title: task.title })}
          className="h-8 w-40 text-xs"
          value={task.sprintId ?? ''}
          onChange={(e) => assign.mutate({ task, sprintId: e.target.value || null })}
        >
          <option value="">{t('tasks.backlog')}</option>
          {open.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      )}
    </li>
  )

  return (
    <div className="grid content-start gap-5 overflow-y-auto p-6">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-[13px] text-muted-foreground">{t('sprints.intro')}</p>
        {manage && (
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            {t('sprints.create')}
          </Button>
        )}
      </div>
      {(action.error || assign.error) && <Alert variant="error">{errorMessage(action.error ?? assign.error)}</Alert>}
      {open.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
          <TimerIcon className="size-8 text-muted-foreground" />
          <p className="text-[15px] font-medium">{t('sprints.empty')}</p>
          <p className="max-w-md text-[13px] text-muted-foreground">{t('sprints.emptyHint')}</p>
        </div>
      )}
      {open.map((s) => {
        const list = tasks.filter((x) => x.sprintId === s.id).sort(compareForList)
        const done = list.filter((x) => x.status.category === 'done').length
        return (
          <section key={s.id} className="overflow-hidden rounded-xl border bg-card">
            <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
              <TimerIcon className="size-5 text-primary" />
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 text-[15px] font-semibold">
                  {s.name}
                  <Badge variant={s.state === 'active' ? 'success' : 'outline'}>{t(`sprints.state.${s.state}`)}</Badge>
                </h2>
                <p className="text-xs text-muted-foreground">
                  {s.startsOn ? formatDueDate(s.startsOn, true) : '…'} – {s.endsOn ? formatDueDate(s.endsOn, true) : '…'} ·{' '}
                  {t('projects.progress', { done, total: list.length })}
                </p>
                {s.goal && <p className="mt-1 text-[13px]">{s.goal}</p>}
              </div>
              {s.state === 'active' && (
                <Button variant="outline" size="sm" onClick={() => onShowBoard(s.id)}>
                  <KanbanIcon />
                  {t('sprints.board')}
                </Button>
              )}
              {manage && s.state === 'planned' && (
                <Button size="sm" onClick={() => action.mutate({ sprint: s, kind: 'start' })} disabled={action.isPending}>
                  <PlayIcon />
                  {t('sprints.start')}
                </Button>
              )}
              {manage && s.state === 'active' && (
                <Button size="sm" onClick={() => setCompleting(s)}>
                  <CircleCheckBigIcon />
                  {t('sprints.complete')}
                </Button>
              )}
              {manage && (
                <>
                  <Button variant="ghost" size="icon-sm" aria-label={t('sprints.edit', { name: s.name })} onClick={() => setEditing(s)}>
                    <PencilIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t('sprints.delete', { name: s.name })} onClick={() => setDeleting(s)}>
                    <Trash2Icon />
                  </Button>
                </>
              )}
            </header>
            {list.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-muted-foreground">{t('sprints.noTasks')}</p>
            ) : (
              <ul className="divide-y">{list.map(row)}</ul>
            )}
          </section>
        )
      })}
      <section className="overflow-hidden rounded-xl border bg-card">
        <header className="border-b px-4 py-3">
          <h2 className="text-[15px] font-semibold">{t('tasks.backlog')}</h2>
          <p className="text-xs text-muted-foreground">{t('sprints.backlogHint', { count: backlog.length })}</p>
        </header>
        {backlog.length === 0 ? <p className="px-4 py-4 text-[13px] text-muted-foreground">{t('sprints.backlogEmpty')}</p> : <ul className="divide-y">{backlog.map(row)}</ul>}
      </section>
      {completed.length > 0 && (
        <section>
          <h2 className="mb-2 text-[14px] font-semibold">{t('sprints.completed')}</h2>
          <ul className="divide-y rounded-xl border bg-card">
            {completed.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <CircleCheckBigIcon className="size-4 text-success" />
                <span className="flex-1 font-medium">{s.name}</span>
                <span className="text-muted-foreground">{t('projects.progress', { done: s.doneCount, total: s.taskCount })}</span>
                {s.completedAt && <span className="text-xs text-muted-foreground">{formatDueDate(s.completedAt.slice(0, 10), true)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {editing && <SprintDialog project={project} sprint={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title={t('sprints.deleteTitle', { name: deleting?.name ?? '' })}
        text={t('sprints.deleteText')}
        action={t('sprints.deleteAction')}
        pending={action.isPending}
        error={action.error}
        onConfirm={() => deleting && action.mutate({ sprint: deleting, kind: 'delete' })}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <Dialog open={completing !== null} onOpenChange={(o) => !o && setCompleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sprints.completeTitle', { name: completing?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('sprints.completeText')}</DialogDescription>
          </DialogHeader>
          {action.error && <Alert variant="error">{errorMessage(action.error)}</Alert>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleting(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={action.isPending} onClick={() => completing && action.mutate({ sprint: completing, kind: 'complete' })}>
              {t('sprints.complete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SprintDialog({ project, sprint, onClose }: { project: ProjectDetail; sprint?: Sprint; onClose: () => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const [form, setForm] = useState({
    name: sprint?.name ?? t('sprints.defaultName', { n: project.sprints.length + 1 }),
    goal: sprint?.goal ?? '',
    startsOn: sprint?.startsOn ?? '',
    endsOn: sprint?.endsOn ?? '',
  })
  const save = useMutation({
    mutationFn: (input: SprintInput) =>
      sprint ? api.updateSprint(orgId, project.id, sprint.id, input) : api.createSprint(orgId, project.id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.project(orgId, project.id) })
      onClose()
    },
  })
  const errors = fieldErrors(save.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate({ name: form.name, goal: form.goal, startsOn: form.startsOn || null, endsOn: form.endsOn || null })
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{sprint ? t('sprints.editTitle') : t('sprints.createTitle')}</DialogTitle>
            <DialogDescription>{t('sprints.dialogDescription')}</DialogDescription>
          </DialogHeader>
          {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
          <Field label={t('sprints.name')} error={errors.name}>
            <Input autoFocus maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t('sprints.goal')} error={errors.goal}>
            <Textarea rows={2} maxLength={500} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('projects.startsOn')} error={errors.startsOn}>
              <Input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />
            </Field>
            <Field label={t('projects.endsOn')} error={errors.endsOn}>
              <Input type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending || !form.name.trim()}>
              {sprint ? t('common.save') : t('sprints.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
