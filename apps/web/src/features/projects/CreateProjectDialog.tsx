import type { ChannelVisibility, ProjectColor } from '@fudislte/api-client'
import {
  Alert,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Textarea,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, GlobeIcon, LockIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'

import { useT } from '../../i18n'
import { api, fieldErrors, formError, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { MemberPicker } from '../chat/MemberPicker'
import { normalizeKey, suggestKey } from './keys'
import { colorDot, projectColors, useProjectLinks } from './projects'

interface Form {
  name: string
  key: string
  keyEdited: boolean
  description: string
  visibility: ChannelVisibility
  color: ProjectColor
  startsOn: string
  endsOn: string
  memberIds: string[]
}

const empty: Form = {
  name: '',
  key: '',
  keyEdited: false,
  description: '',
  visibility: 'public',
  color: 'blue',
  startsOn: '',
  endsOn: '',
  memberIds: [],
}

/** Creates a project led by the caller (projects.create) and opens it. */
export function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const navigate = useNavigate()
  const links = useProjectLinks()
  const qc = useQueryClient()
  const [form, setForm] = useState(empty)
  const create = useMutation({
    mutationFn: () =>
      api.createProject(orgId, {
        name: form.name,
        key: form.key,
        description: form.description,
        visibility: form.visibility,
        color: form.color,
        startsOn: form.startsOn || null,
        endsOn: form.endsOn || null,
        memberIds: form.memberIds,
      }),
    onSuccess: async (project) => {
      qc.setQueryData(queryKeys.project(orgId, project.id), project)
      await qc.invalidateQueries({ queryKey: queryKeys.projects(orgId) })
      close()
      navigate(links.project(project.id))
    },
  })
  const close = () => {
    onOpenChange(false)
    setForm(empty)
    create.reset()
  }
  const errors = fieldErrors(create.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('projects.createTitle')}</DialogTitle>
            <DialogDescription>{t('projects.createDescription')}</DialogDescription>
          </DialogHeader>
          {formError(create.error) && <Alert variant="error">{formError(create.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field label={t('projects.name')} error={errors.name}>
              <Input
                autoFocus
                maxLength={80}
                placeholder={t('projects.namePlaceholder')}
                value={form.name}
                onChange={(e) =>
                  setForm({ ...form, name: e.target.value, key: form.keyEdited ? form.key : suggestKey(e.target.value) })
                }
              />
            </Field>
            <Field label={t('projects.key')} error={errors.key} hint={errors.key ? undefined : t('projects.keyHint')}>
              <Input
                maxLength={6}
                className="font-mono uppercase"
                value={form.key}
                onChange={(e) => setForm({ ...form, key: normalizeKey(e.target.value), keyEdited: true })}
              />
            </Field>
          </div>
          <Field label={t('projects.descriptionLabel')} error={errors.description}>
            <Textarea
              rows={3}
              maxLength={2000}
              placeholder={t('projects.descriptionPlaceholder')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <VisibilityChoice value={form.visibility} onChange={(visibility) => setForm({ ...form, visibility })} />
          <ColorChoice value={form.color} onChange={(color) => setForm({ ...form, color })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('projects.startsOn')} error={errors.startsOn}>
              <Input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />
            </Field>
            <Field label={t('projects.endsOn')} error={errors.endsOn}>
              <Input type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />
            </Field>
          </div>
          {can(workspace, 'members.view') && (
            <div className="grid gap-1.5">
              <p className="text-[13px] font-medium">{t('projects.members')}</p>
              <p className="text-xs text-muted-foreground">{t('projects.membersHint')}</p>
              <MemberPicker selected={form.memberIds} onChange={(memberIds) => setForm({ ...form, memberIds })} max={200} />
              {errors.memberIds && <p className="text-xs text-destructive">{errors.memberIds}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !form.name.trim() || form.key.length < 2}>
              {t('projects.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Public or private, as two cards. */
export function VisibilityChoice({ value, onChange }: { value: ChannelVisibility; onChange: (v: ChannelVisibility) => void }) {
  const t = useT()
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-[13px] font-medium">{t('projects.visibility')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(['public', 'private'] as const).map((v) => {
          const Icon = v === 'public' ? GlobeIcon : LockIcon
          return (
            <label
              key={v}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                value === v ? 'border-primary bg-primary-soft/50' : 'hover:bg-accent/50',
              )}
            >
              <input type="radio" name="visibility" className="sr-only" checked={value === v} onChange={() => onChange(v)} />
              <Icon className={cn('mt-0.5 size-4 shrink-0', value === v ? 'text-primary' : 'text-muted-foreground')} />
              <span>
                <span className="block text-[13px] font-medium">{t(`projects.visibility.${v}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`projects.visibilityHint.${v}`)}</span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** The project palette as round swatches (radio buttons). */
export function ColorChoice({ value, onChange, label }: { value: ProjectColor; onChange: (c: ProjectColor) => void; label?: string }) {
  const t = useT()
  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] font-medium">{label ?? t('projects.color')}</legend>
      <div className="flex flex-wrap gap-2">
        {projectColors.map((c) => (
          <label key={c} className="relative cursor-pointer rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/60">
            <input type="radio" className="sr-only" checked={value === c} onChange={() => onChange(c)} aria-label={t(`colors.${c}`)} />
            <span className={cn('flex size-7 items-center justify-center rounded-full text-white', colorDot[c])}>
              {value === c && <CheckIcon className="size-4" />}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
