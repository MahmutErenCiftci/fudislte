import type { ProjectDetail, Task, TaskPriority } from '@fudislte/api-client'
import {
  Alert,
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
import { type FormEvent, useState } from 'react'

import { useT } from '../../i18n'
import { api, fieldErrors, formError } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { taskSaved } from './cache'
import { priorities, priorityLabel } from './projects'

interface Form {
  title: string
  description: string
  statusId: string
  priority: TaskPriority
  dueOn: string
  sprintId: string
  assigneeId: string
}

/** "Görev ekle": a new task with its main fields; the rest is set in the task dialog. */
export function CreateTaskDialog({
  project,
  open,
  onOpenChange,
  onCreated,
}: {
  project: ProjectDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (task: Task) => void
}) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const blank = (): Form => ({
    title: '',
    description: '',
    statusId: project.statuses[0]?.id ?? '',
    priority: 'none',
    dueOn: '',
    sprintId: project.sprints.find((s) => s.state === 'active')?.id ?? '',
    assigneeId: '',
  })
  const [form, setForm] = useState(blank)
  const create = useMutation({
    mutationFn: () =>
      api.createTask(orgId, project.id, {
        title: form.title,
        description: form.description,
        statusId: form.statusId,
        priority: form.priority,
        dueOn: form.dueOn || null,
        sprintId: form.sprintId || null,
        assigneeIds: form.assigneeId ? [form.assigneeId] : [],
      }),
    onSuccess: (task) => {
      taskSaved(qc, orgId, task)
      close()
      onCreated(task)
    },
  })
  const close = () => {
    onOpenChange(false)
    setForm(blank())
    create.reset()
  }
  const errors = fieldErrors(create.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('tasks.createTitle')}</DialogTitle>
            <DialogDescription>{t('tasks.createDescription', { project: project.name })}</DialogDescription>
          </DialogHeader>
          {formError(create.error) && <Alert variant="error">{formError(create.error)}</Alert>}
          <Field label={t('tasks.titleLabel')} error={errors.title}>
            <Input autoFocus maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label={t('tasks.description')} error={errors.description}>
            <Textarea rows={3} maxLength={10000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('tasks.colStatus')} error={errors.statusId}>
              <NativeSelect value={form.statusId} onChange={(e) => setForm({ ...form, statusId: e.target.value })}>
                {project.statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('tasks.assignee')} error={errors.assigneeIds}>
              <NativeSelect value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
                <option value="">{t('tasks.unassigned')}</option>
                {project.members.map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.displayName}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('tasks.priority')} error={errors.priority}>
              <NativeSelect value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {t(priorityLabel(p))}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('tasks.due')} error={errors.dueOn}>
              <Input type="date" value={form.dueOn} onChange={(e) => setForm({ ...form, dueOn: e.target.value })} />
            </Field>
            <Field label={t('tasks.sprint')} error={errors.sprintId}>
              <NativeSelect value={form.sprintId} onChange={(e) => setForm({ ...form, sprintId: e.target.value })}>
                <option value="">{t('tasks.backlog')}</option>
                {project.sprints
                  .filter((s) => s.state !== 'completed')
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !form.title.trim()}>
              {t('tasks.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
