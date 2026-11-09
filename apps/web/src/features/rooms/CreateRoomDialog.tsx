import type { RoomAccess } from '@fudislte/api-client'
import {
  Alert,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRoundIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'

import { useT } from '../../i18n'
import { api, fieldErrors, formError, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { MemberPicker } from '../chat/MemberPicker'
import { accessIcons, admissionChoices, formatMinutes } from './rooms'

const empty = {
  name: '',
  topic: '',
  access: 'protected' as RoomAccess,
  password: '',
  confirm: '',
  withPassword: false,
  admissionMinutes: 12 * 60,
  memberIds: [] as string[],
}

/** Access choices, shared with the room settings. */
export function AccessChoices({ value, onChange }: { value: RoomAccess; onChange: (access: RoomAccess) => void }) {
  const t = useT()
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-[13px] font-medium">{t('rooms.accessLabel')}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {(['open', 'protected', 'restricted'] as const).map((access) => {
          const Icon = accessIcons[access]
          return (
            <label
              key={access}
              className={cn(
                'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                value === access ? 'border-primary bg-primary-soft/60' : 'hover:bg-accent/60',
              )}
            >
              <input type="radio" name="access" className="sr-only" checked={value === access} onChange={() => onChange(access)} />
              <span className="flex items-center gap-2 text-[13px] font-medium">
                <Icon className={cn('size-4', value === access ? 'text-primary' : 'text-muted-foreground')} />
                {t(`rooms.access.${access}`)}
              </span>
              <span className="text-xs text-muted-foreground">{t(`rooms.accessHint.${access}`)}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

export function AdmissionSelect({ value, onChange, error }: { value: number; onChange: (m: number) => void; error?: string }) {
  const t = useT()
  const choices = admissionChoices.includes(value) ? admissionChoices : [...admissionChoices, value].sort((a, b) => a - b)
  return (
    <Field label={t('rooms.admission')} hint={t('rooms.admissionHint')} error={error}>
      <NativeSelect value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {choices.map((m) => (
          <option key={m} value={m}>
            {formatMinutes(m)}
          </option>
        ))}
      </NativeSelect>
    </Field>
  )
}

export function CreateRoomDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState(empty)
  const [mismatch, setMismatch] = useState(false)
  const canPickMembers = can(workspace, 'members.view')
  const asksPassword = form.access === 'protected' || (form.access === 'restricted' && form.withPassword)

  const close = () => {
    onOpenChange(false)
    setForm(empty)
    setMismatch(false)
    create.reset()
  }
  const create = useMutation({
    mutationFn: () =>
      api.createRoom(orgId, {
        name: form.name,
        topic: form.topic,
        access: form.access,
        password: asksPassword ? form.password : undefined,
        admissionMinutes: form.admissionMinutes,
        memberIds: form.access === 'restricted' ? form.memberIds : undefined,
      }),
    onSuccess: async (room) => {
      qc.setQueryData(queryKeys.room(orgId, room.id), room)
      await qc.invalidateQueries({ queryKey: queryKeys.rooms(orgId) })
      close()
      navigate(`/w/${workspace.organization.slug}/r/${room.id}`)
    },
  })
  const errors = fieldErrors(create.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (asksPassword && form.password !== form.confirm) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    create.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('rooms.createTitle')}</DialogTitle>
            <DialogDescription>{t('rooms.createDescription')}</DialogDescription>
          </DialogHeader>
          {formError(create.error) && <Alert variant="error">{formError(create.error)}</Alert>}
          <Field label={t('rooms.name')} error={errors.name}>
            <Input
              autoFocus
              maxLength={60}
              placeholder={t('rooms.namePlaceholder')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label={t('rooms.topic')} error={errors.topic}>
            <Input
              maxLength={250}
              placeholder={t('rooms.topicPlaceholder')}
              value={form.topic}
              onChange={(e) => setForm({ ...form, topic: e.target.value })}
            />
          </Field>
          <AccessChoices value={form.access} onChange={(access) => setForm({ ...form, access })} />
          {form.access === 'restricted' && (
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox
                checked={form.withPassword}
                onCheckedChange={(checked) => setForm({ ...form, withPassword: checked === true })}
              />
              {t('rooms.requirePassword')}
            </label>
          )}
          {asksPassword && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('rooms.password')} error={errors.password} hint={t('rooms.passwordHint')}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  icon={<KeyRoundIcon />}
                  maxLength={128}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </Field>
              <Field label={t('rooms.passwordConfirm')} error={mismatch ? t('rooms.passwordMismatch') : undefined}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  icon={<KeyRoundIcon />}
                  maxLength={128}
                  value={form.confirm}
                  onChange={(e) => setForm({ ...form, confirm: e.target.value })}
                />
              </Field>
            </div>
          )}
          {asksPassword && (
            <AdmissionSelect
              value={form.admissionMinutes}
              onChange={(admissionMinutes) => setForm({ ...form, admissionMinutes })}
              error={errors.admissionMinutes}
            />
          )}
          {form.access === 'restricted' && canPickMembers && (
            <div className="grid gap-1.5">
              <p className="text-[13px] font-medium">{t('rooms.allowedPeople')}</p>
              <p className="text-xs text-muted-foreground">{t('rooms.allowedHint')}</p>
              <MemberPicker selected={form.memberIds} onChange={(memberIds) => setForm({ ...form, memberIds })} />
              {errors.memberIds && <p className="text-xs text-destructive">{errors.memberIds}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !form.name.trim()}>
              {t('rooms.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
