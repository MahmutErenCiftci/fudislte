import type { ProjectDetail, TaskDetail, TaskInput } from '@fudislte/api-client'
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
  NativeSelect,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Textarea,
  Tooltip,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, LinkIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useWorkspace } from '../../shell/context'
import { ConfirmDialog } from '../chat/ChannelDialogs'
import { MessageText } from '../chat/MessageText'
import { removeTask, taskSaved } from './cache'
import { LabelChip, priorities, priorityLabel, StatusDot } from './projects'
import { Activity, Checklist, Comments, Links } from './TaskSections'

/** The task dialog (?task=<id>): every field, checklist, comments, links and activity. */
export function TaskDialog({ project, taskId, onClose }: { project: ProjectDetail; taskId: string; onClose: () => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const task = useQuery({ queryKey: queryKeys.task(orgId, taskId), queryFn: () => api.task(orgId, project.id, taskId) })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-4xl">
        {task.data ? (
          <TaskBody project={project} task={task.data} onClose={onClose} />
        ) : (
          <>
            <DialogTitle className="sr-only">{t('tasks.task')}</DialogTitle>
            <DialogDescription className="sr-only">{t('common.loading')}</DialogDescription>
            {task.error ? <Alert variant="error">{errorMessage(task.error)}</Alert> : <Spinner label={t('common.loading')} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TaskBody({ project, task, onClose }: { project: ProjectDetail; task: TaskDetail; onClose: () => void }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const editable = project.canEdit
  const [tab, setTab] = useState<'comments' | 'activity'>('comments')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copied, setCopied] = useState(false)
  const update = useMutation({
    mutationFn: (input: TaskInput) => api.updateTask(orgId, project.id, task.id, input),
    onSuccess: (saved) => taskSaved(qc, orgId, saved),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteTask(orgId, project.id, task.id),
    onSuccess: () => {
      removeTask(qc, orgId, project.id, task.id)
      void qc.invalidateQueries({ queryKey: queryKeys.myTasks(orgId) })
      onClose()
    },
  })
  const canDelete = editable && (project.canManage || task.createdBy === me.user.id)
  const sprints = project.sprints.filter((s) => s.state !== 'completed' || s.id === task.sprintId)
  const copyLink = () =>
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2 pr-8 text-xs text-muted-foreground">
        <span className="font-mono font-medium">{task.key}</span>
        <span>·</span>
        <span className="truncate">{project.name}</span>
        <Tooltip content={copied ? t('common.copied') : t('tasks.copyLink')} side="bottom">
          <Button variant="ghost" size="icon-sm" className="size-6" aria-label={t('tasks.copyLink')} onClick={copyLink}>
            {copied ? <CheckIcon className="size-3.5" /> : <LinkIcon className="size-3.5" />}
          </Button>
        </Tooltip>
      </div>
      <TitleField task={task} editable={editable} onSave={(title) => update.mutate({ title })} />
      <DialogDescription className="sr-only">{t('tasks.dialogDescription')}</DialogDescription>
      {update.error && <Alert variant="error">{errorMessage(update.error)}</Alert>}

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="grid min-w-0 content-start gap-6">
          <DescriptionField task={task} editable={editable} pending={update.isPending} onSave={(description) => update.mutate({ description })} />
          <Checklist task={task} editable={editable} />
          <section className="grid gap-3">
            <nav className="flex gap-1 border-b">
              {(['comments', 'activity'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-current={tab === k ? 'page' : undefined}
                  onClick={() => setTab(k)}
                  className={cn(
                    '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:text-foreground',
                    tab === k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {k === 'comments' ? t('tasks.commentsTab', { count: task.comments.length }) : t('tasks.activityTab')}
                </button>
              ))}
            </nav>
            {tab === 'comments' ? <Comments task={task} editable={editable} canModerate={project.canManage} /> : <Activity task={task} />}
          </section>
        </div>

        <aside className="grid content-start gap-4 text-[13px]">
          <Prop label={t('tasks.colStatus')}>
            {(id) => (
              <NativeSelect id={id} disabled={!editable} value={task.status.id} onChange={(e) => update.mutate({ statusId: e.target.value })}>
                {project.statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Prop>
          <Prop label={t('tasks.assignees')}>
            {() => (
              <PeopleField
                project={project}
                selected={task.assignees.map((p) => p.id)}
                editable={editable}
                onChange={(assigneeIds) => update.mutate({ assigneeIds })}
              />
            )}
          </Prop>
          <Prop label={t('tasks.labels')}>
            {() => (
              <LabelsField project={project} task={task} editable={editable} onChange={(labelIds) => update.mutate({ labelIds })} />
            )}
          </Prop>
          <Prop label={t('tasks.priority')}>
            {(id) => (
              <NativeSelect
                id={id}
                disabled={!editable}
                value={task.priority}
                onChange={(e) => update.mutate({ priority: e.target.value as TaskInput['priority'] })}
              >
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {t(priorityLabel(p))}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Prop>
          <Prop label={t('tasks.due')}>
            {(id) => (
              <Input
                id={id}
                type="date"
                disabled={!editable}
                value={task.dueOn ?? ''}
                onChange={(e) => update.mutate({ dueOn: e.target.value || null })}
              />
            )}
          </Prop>
          <Prop label={t('tasks.sprint')}>
            {(id) => (
              <NativeSelect
                id={id}
                disabled={!editable}
                value={task.sprintId ?? ''}
                onChange={(e) => update.mutate({ sprintId: e.target.value || null })}
              >
                <option value="">{t('tasks.backlog')}</option>
                {sprints.map((s) => (
                  <option key={s.id} value={s.id} disabled={s.state === 'completed'}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Prop>
          <Prop label={t('tasks.links')}>{() => <Links task={task} editable={editable} />}</Prop>
          <dl className="grid gap-1 border-t pt-3 text-xs text-muted-foreground">
            <div className="flex justify-between gap-2">
              <dt>{t('tasks.createdBy')}</dt>
              <dd className="truncate text-foreground">{task.creator?.displayName ?? t('audit.deletedUser')}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>{t('tasks.createdAt')}</dt>
              <dd>{formatDateTime(task.createdAt)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>{t('tasks.updatedAt')}</dt>
              <dd>{formatDateTime(task.updatedAt)}</dd>
            </div>
            {task.completedAt && (
              <div className="flex justify-between gap-2">
                <dt>{t('tasks.completedAt')}</dt>
                <dd>{formatDateTime(task.completedAt)}</dd>
              </div>
            )}
          </dl>
          {canDelete && (
            <Button variant="outline" size="sm" className="justify-start text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon />
              {t('tasks.delete')}
            </Button>
          )}
        </aside>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={t('tasks.deleteTitle', { key: task.key })}
        text={t('tasks.deleteText')}
        action={t('tasks.delete')}
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
        onOpenChange={setConfirmDelete}
      />
    </div>
  )
}

function Prop({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children(id)}
    </div>
  )
}

function TitleField({ task, editable, onSave }: { task: TaskDetail; editable: boolean; onSave: (title: string) => void }) {
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)
  if (!editable || draft === null) {
    return (
      <DialogTitle className="flex items-start gap-2 text-xl font-bold tracking-tight">
        <StatusDot color={task.status.color} className="mt-2.5" />
        <span className="min-w-0 flex-1 break-words">{task.title}</span>
        {editable && (
          <Button variant="ghost" size="icon-sm" aria-label={t('tasks.editTitle')} onClick={() => setDraft(task.title)}>
            <PencilIcon />
          </Button>
        )}
      </DialogTitle>
    )
  }
  const save = () => {
    if (draft.trim() && draft.trim() !== task.title) onSave(draft)
    setDraft(null)
  }
  return (
    <>
      <DialogTitle className="sr-only">{task.title}</DialogTitle>
      <Input
        autoFocus
        maxLength={200}
        aria-label={t('tasks.titleLabel')}
        className="h-10 text-lg font-semibold"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') {
            e.stopPropagation()
            setDraft(null)
          }
        }}
      />
    </>
  )
}

function DescriptionField({
  task,
  editable,
  pending,
  onSave,
}: {
  task: TaskDetail
  editable: boolean
  pending: boolean
  onSave: (description: string) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold">
        {t('tasks.description')}
        {editable && draft === null && (
          <Button variant="ghost" size="icon-sm" className="size-6" aria-label={t('tasks.editDescription')} onClick={() => setDraft(task.description)}>
            <PencilIcon className="size-3.5" />
          </Button>
        )}
      </h3>
      {draft !== null ? (
        <div className="grid gap-2">
          <Textarea autoFocus rows={6} maxLength={10000} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                onSave(draft)
                setDraft(null)
              }}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      ) : task.description ? (
        <div className="text-[13px]">
          <MessageText body={task.description} />
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('tasks.noDescription')}</p>
      )}
    </section>
  )
}

/** Assignees: project members, chosen in a popover. */
function PeopleField({
  project,
  selected,
  editable,
  onChange,
}: {
  project: ProjectDetail
  selected: string[]
  editable: boolean
  onChange: (ids: string[]) => void
}) {
  const t = useT()
  const people = project.members.filter((m) => selected.includes(m.user.id))
  const chips = (
    <span className="flex flex-wrap gap-1">
      {selected.length === 0 && <span className="text-muted-foreground">{t('tasks.unassigned')}</span>}
      {people.map((m) => (
        <span key={m.user.id} className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs">
          <Avatar name={m.user.displayName} seed={m.user.id} size="xs" />
          {m.user.displayName}
        </span>
      ))}
    </span>
  )
  if (!editable) return chips
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded-lg border px-2 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50">
          {chips}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid max-h-72 w-60 gap-0.5 overflow-y-auto p-1.5">
        {project.members.map((m) => (
          <label key={m.user.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent">
            <Checkbox
              checked={selected.includes(m.user.id)}
              disabled={!selected.includes(m.user.id) && selected.length >= 10}
              onCheckedChange={(v) => onChange(v === true ? [...selected, m.user.id] : selected.filter((id) => id !== m.user.id))}
            />
            <Avatar name={m.user.displayName} seed={m.user.id} size="xs" />
            <span className="truncate">{m.user.displayName}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function LabelsField({
  project,
  task,
  editable,
  onChange,
}: {
  project: ProjectDetail
  task: TaskDetail
  editable: boolean
  onChange: (ids: string[]) => void
}) {
  const t = useT()
  const selected = task.labels.map((l) => l.id)
  const chips = (
    <span className="flex flex-wrap gap-1">
      {task.labels.length === 0 && <span className="text-muted-foreground">{t('tasks.noLabelsSet')}</span>}
      {task.labels.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
    </span>
  )
  if (!editable) return chips
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded-lg border px-2 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50">
          {chips}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid max-h-72 w-60 gap-0.5 overflow-y-auto p-1.5">
        {project.labels.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t('tasks.noLabels')}</p>}
        {project.labels.map((l) => (
          <label key={l.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
            <Checkbox
              checked={selected.includes(l.id)}
              disabled={!selected.includes(l.id) && selected.length >= 10}
              onCheckedChange={(v) => onChange(v === true ? [...selected, l.id] : selected.filter((id) => id !== l.id))}
            />
            <LabelChip label={l} />
          </label>
        ))}
      </PopoverContent>
    </Popover>
  )
}
