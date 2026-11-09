import type { ProjectColor, ProjectDetail, ProjectLabel, ProjectRole, StatusCategory, WorkflowStatus } from '@fudislte/api-client'
import {
  Alert,
  Avatar,
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
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { MemberPicker } from '../chat/MemberPicker'
import { ColorChoice, VisibilityChoice } from './CreateProjectDialog'
import { normalizeKey } from './keys'
import { colorDot, LabelChip, projectColors, StatusDot } from './projects'

const categories: StatusCategory[] = ['todo', 'in_progress', 'review', 'done']

/** "Ayarlar" for leads and project managers: general settings, workflow, labels, members, archive. */
export function ProjectSettings({ project }: { project: ProjectDetail }) {
  const t = useT()
  return (
    <div className="grid max-w-3xl content-start gap-6 overflow-y-auto p-6">
      {project.status === 'archived' && <Alert>{t('projects.archivedSettings')}</Alert>}
      <Section title={t('settings.general')} text={t('settings.generalText')}>
        <GeneralForm project={project} />
      </Section>
      <Section title={t('settings.workflow')} text={t('settings.workflowText')}>
        <Workflow project={project} />
      </Section>
      <Section title={t('tasks.labels')} text={t('settings.labelsText')}>
        <Labels project={project} />
      </Section>
      <Section title={t('projects.members')} text={t('settings.membersText')}>
        <Members project={project} />
      </Section>
      <Section title={t('settings.archive')} text={project.status === 'active' ? t('settings.archiveText') : t('settings.restoreText')}>
        <ArchiveButton project={project} />
      </Section>
    </div>
  )
}

function Section({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mt-1 mb-4 text-[13px] text-muted-foreground">{text}</p>
      {children}
    </section>
  )
}

/** Refetches the project after a settings change (other people get project.updated). */
function useRefresh(project: ProjectDetail) {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: queryKeys.project(orgId, project.id) })
    void qc.invalidateQueries({ queryKey: queryKeys.projectTasks(orgId, project.id) })
    void qc.invalidateQueries({ queryKey: queryKeys.projects(orgId) })
  }
}

function GeneralForm({ project }: { project: ProjectDetail }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const refresh = useRefresh(project)
  const [form, setForm] = useState({
    name: project.name,
    key: project.key,
    description: project.description,
    color: project.color,
    visibility: project.visibility,
    startsOn: project.startsOn ?? '',
    endsOn: project.endsOn ?? '',
  })
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: () => api.updateProject(orgId, project.id, { ...form, startsOn: form.startsOn || null, endsOn: form.endsOn || null }),
    onSuccess: () => {
      refresh()
      setSaved(true)
    },
  })
  const errors = fieldErrors(save.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSaved(false)
    save.mutate()
  }
  const disabled = project.status === 'archived'
  return (
    <form className="grid gap-4" onSubmit={submit}>
      {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
      {saved && !save.isPending && <Alert>{t('common.saved')}</Alert>}
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field label={t('projects.name')} error={errors.name}>
          <Input maxLength={80} disabled={disabled} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t('projects.key')} error={errors.key}>
          <Input
            maxLength={6}
            className="font-mono uppercase"
            disabled={disabled}
            value={form.key}
            onChange={(e) => setForm({ ...form, key: normalizeKey(e.target.value) })}
          />
        </Field>
      </div>
      {form.key !== project.key && <p className="-mt-2 text-xs text-muted-foreground">{t('settings.keyChange', { key: form.key || '…' })}</p>}
      <Field label={t('projects.descriptionLabel')} error={errors.description}>
        <Textarea rows={3} maxLength={2000} disabled={disabled} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <VisibilityChoice value={form.visibility} onChange={(visibility) => setForm({ ...form, visibility })} />
      {form.visibility !== project.visibility && form.visibility === 'private' && (
        <Alert>{t('settings.privateWarning')}</Alert>
      )}
      <ColorChoice value={form.color} onChange={(color) => setForm({ ...form, color })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('projects.startsOn')} error={errors.startsOn}>
          <Input type="date" disabled={disabled} value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />
        </Field>
        <Field label={t('projects.endsOn')} error={errors.endsOn}>
          <Input type="date" disabled={disabled} value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={disabled || save.isPending || !form.name.trim() || form.key.length < 2}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}

function Workflow({ project }: { project: ProjectDetail }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const refresh = useRefresh(project)
  const [deleting, setDeleting] = useState<WorkflowStatus | null>(null)
  const [name, setName] = useState('')
  const change = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: refresh })
  const disabled = project.status === 'archived'
  const move = (i: number, delta: number) => {
    const ids = project.statuses.map((s) => s.id)
    const [id] = ids.splice(i, 1)
    if (!id) return
    ids.splice(i + delta, 0, id)
    change.mutate(() => api.reorderStatuses(orgId, project.id, ids))
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    change.mutate(() => api.createStatus(orgId, project.id, { name, category: 'in_progress', color: 'sky' }), {
      onSuccess: () => setName(''),
    })
  }
  return (
    <div className="grid gap-3">
      {change.error && <Alert variant="error">{errorMessage(change.error)}</Alert>}
      <ul className="grid gap-2">
        {project.statuses.map((s, i) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
            <StatusDot color={s.color} />
            <Input
              aria-label={t('settings.statusName')}
              className="h-8 w-44 text-[13px]"
              maxLength={40}
              disabled={disabled}
              defaultValue={s.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && change.mutate(() => api.updateStatus(orgId, project.id, s.id, { name: e.target.value }))}
            />
            <NativeSelect
              aria-label={t('settings.statusCategory')}
              className="h-8 w-40 text-[13px]"
              disabled={disabled}
              value={s.category}
              onChange={(e) => change.mutate(() => api.updateStatus(orgId, project.id, s.id, { category: e.target.value as StatusCategory }))}
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {t(`settings.category.${c}`)}
                </option>
              ))}
            </NativeSelect>
            <ColorSelect
              value={s.color}
              disabled={disabled}
              onChange={(color) => change.mutate(() => api.updateStatus(orgId, project.id, s.id, { color }))}
            />
            <span className="ml-auto flex gap-1">
              <Button variant="ghost" size="icon-sm" disabled={disabled || i === 0} aria-label={t('settings.moveLeft', { name: s.name })} onClick={() => move(i, -1)}>
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled || i === project.statuses.length - 1}
                aria-label={t('settings.moveRight', { name: s.name })}
                onClick={() => move(i, 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled || project.statuses.length <= 1}
                aria-label={t('settings.deleteStatus', { name: s.name })}
                onClick={() => setDeleting(s)}
              >
                <Trash2Icon />
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {!disabled && project.statuses.length < 12 && (
        <form onSubmit={add} className="flex gap-2">
          <Input
            className="h-8 max-w-xs text-[13px]"
            maxLength={40}
            placeholder={t('settings.newStatus')}
            aria-label={t('settings.newStatus')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || change.isPending}>
            <PlusIcon />
            {t('settings.addStatus')}
          </Button>
        </form>
      )}
      {deleting && <DeleteStatusDialog project={project} status={deleting} onClose={() => setDeleting(null)} />}
    </div>
  )
}

function DeleteStatusDialog({ project, status, onClose }: { project: ProjectDetail; status: WorkflowStatus; onClose: () => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const refresh = useRefresh(project)
  const others = project.statuses.filter((s) => s.id !== status.id)
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '')
  const remove = useMutation({
    mutationFn: () => api.deleteStatus(orgId, project.id, status.id, moveTo),
    onSuccess: () => {
      refresh()
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.deleteStatusTitle', { name: status.name })}</DialogTitle>
          <DialogDescription>{t('settings.deleteStatusText')}</DialogDescription>
        </DialogHeader>
        {remove.error && <Alert variant="error">{errorMessage(remove.error)}</Alert>}
        <Field label={t('settings.moveTasksTo')}>
          <NativeSelect value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t('settings.deleteStatusAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ColorSelect({ value, disabled, onChange }: { value: ProjectColor; disabled?: boolean; onChange: (c: ProjectColor) => void }) {
  const t = useT()
  return (
    <span className="relative">
      <span aria-hidden="true" className={`pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 rounded-full ${colorDot[value]}`} />
      <NativeSelect
        aria-label={t('projects.color')}
        className="h-8 w-32 pl-7 text-[13px]"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value as ProjectColor)}
      >
        {projectColors.map((c) => (
          <option key={c} value={c}>
            {t(`colors.${c}`)}
          </option>
        ))}
      </NativeSelect>
    </span>
  )
}

function Labels({ project }: { project: ProjectDetail }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const refresh = useRefresh(project)
  const [name, setName] = useState('')
  const [color, setColor] = useState<ProjectColor>('blue')
  const change = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: refresh })
  const disabled = project.status === 'archived'
  const add = (e: FormEvent) => {
    e.preventDefault()
    change.mutate(() => api.createLabel(orgId, project.id, { name, color }), { onSuccess: () => setName('') })
  }
  const update = (l: ProjectLabel, input: Partial<Pick<ProjectLabel, 'name' | 'color'>>) =>
    change.mutate(() => api.updateLabel(orgId, project.id, l.id, input))
  return (
    <div className="grid gap-3">
      {change.error && <Alert variant="error">{errorMessage(change.error)}</Alert>}
      {project.labels.length === 0 && <p className="text-[13px] text-muted-foreground">{t('tasks.noLabels')}</p>}
      <ul className="grid gap-2">
        {project.labels.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-2">
            <LabelChip label={l} className="w-28 justify-center" />
            <Input
              aria-label={t('settings.labelName')}
              className="h-8 w-44 text-[13px]"
              maxLength={30}
              disabled={disabled}
              defaultValue={l.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && update(l, { name: e.target.value })}
            />
            <ColorSelect value={l.color} disabled={disabled} onChange={(c) => update(l, { color: c })} />
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={t('settings.deleteLabel', { name: l.name })}
              onClick={() => change.mutate(() => api.deleteLabel(orgId, project.id, l.id))}
            >
              <Trash2Icon />
            </Button>
          </li>
        ))}
      </ul>
      {!disabled && (
        <form onSubmit={add} className="flex flex-wrap gap-2">
          <Input
            className="h-8 w-44 text-[13px]"
            maxLength={30}
            placeholder={t('settings.newLabel')}
            aria-label={t('settings.newLabel')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <ColorSelect value={color} onChange={setColor} />
          <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || change.isPending}>
            <PlusIcon />
            {t('settings.addLabel')}
          </Button>
        </form>
      )}
    </div>
  )
}

function Members({ project }: { project: ProjectDetail }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const refresh = useRefresh(project)
  const [picked, setPicked] = useState<string[]>([])
  const change = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: refresh })
  const disabled = project.status === 'archived'
  return (
    <div className="grid gap-4">
      {change.error && <Alert variant="error">{errorMessage(change.error)}</Alert>}
      <ul className="divide-y rounded-lg border">
        {project.members.map((m) => (
          <li key={m.user.id} className="flex items-center gap-3 px-3 py-2">
            <Avatar name={m.user.displayName} seed={m.user.id} size="sm" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {m.user.displayName}
              {m.user.id === me.user.id && <span className="ml-1 font-normal text-muted-foreground">{t('voice.you')}</span>}
            </span>
            <NativeSelect
              aria-label={t('settings.role', { name: m.user.displayName })}
              className="h-8 w-28 text-[13px]"
              disabled={disabled}
              value={m.role}
              onChange={(e) => change.mutate(() => api.setProjectRole(orgId, project.id, m.user.id, e.target.value as ProjectRole))}
            >
              <option value="lead">{t('projects.role.lead')}</option>
              <option value="member">{t('projects.role.member')}</option>
            </NativeSelect>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={t('settings.removeMember', { name: m.user.displayName })}
              onClick={() => change.mutate(() => api.removeProjectMember(orgId, project.id, m.user.id))}
            >
              <Trash2Icon />
            </Button>
          </li>
        ))}
      </ul>
      {!disabled && can(workspace, 'members.view') && (
        <div className="grid gap-2">
          <p className="text-[13px] font-medium">{t('settings.addMembers')}</p>
          <MemberPicker selected={picked} onChange={setPicked} exclude={project.members.map((m) => m.user.id)} max={200} />
          <div>
            <Button
              size="sm"
              disabled={picked.length === 0 || change.isPending}
              onClick={() => change.mutate(() => api.addProjectMembers(orgId, project.id, picked), { onSuccess: () => setPicked([]) })}
            >
              <PlusIcon />
              {t('settings.addSelected', { count: picked.length })}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ArchiveButton({ project }: { project: ProjectDetail }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const refresh = useRefresh(project)
  const archive = useMutation({ mutationFn: () => api.archiveProject(orgId, project.id, project.status === 'active'), onSuccess: refresh })
  return (
    <div className="grid gap-2">
      {archive.error && <Alert variant="error">{errorMessage(archive.error)}</Alert>}
      <div>
        <Button variant={project.status === 'active' ? 'destructive' : 'default'} disabled={archive.isPending} onClick={() => archive.mutate()}>
          {project.status === 'active' ? t('projects.archive') : t('projects.restore')}
        </Button>
      </div>
    </div>
  )
}
