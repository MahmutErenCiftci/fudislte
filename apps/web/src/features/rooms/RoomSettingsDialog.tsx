import type { Room, RoomAccess } from '@fudislte/api-client'
import {
  Alert,
  Avatar,
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
  Spinner,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRoundIcon, TriangleAlertIcon } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { MemberPicker } from '../chat/MemberPicker'
import { AccessChoices, AdmissionSelect } from './CreateRoomDialog'
import { formatMinutes } from './rooms'

type Tab = 'general' | 'security' | 'people'

/** Room settings for its managers; the people tab is also open to everyone inside. */
export function RoomSettingsDialog({
  room,
  tab: initialTab,
  open,
  onOpenChange,
}: {
  room: Room
  tab: Tab
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const [tab, setTab] = useState<Tab>(initialTab)
  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])
  const tabs: Tab[] = room.canManage ? ['general', 'security', 'people'] : ['people']
  const labels: Record<Tab, string> = {
    general: t('rooms.tabGeneral'),
    security: t('rooms.tabSecurity'),
    people: t('rooms.tabPeople'),
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{room.canManage ? t('rooms.settings') : t('rooms.participants')}</DialogTitle>
          <DialogDescription>{room.name}</DialogDescription>
        </DialogHeader>
        {tabs.length > 1 && (
          <nav className="-mt-1 flex gap-1 border-b">
            {tabs.map((key) => (
              <button
                key={key}
                type="button"
                aria-current={tab === key ? 'page' : undefined}
                onClick={() => setTab(key)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium outline-none transition-colors focus-visible:text-foreground',
                  tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {labels[key]}
              </button>
            ))}
          </nav>
        )}
        {tab === 'general' && room.canManage && <GeneralTab room={room} onDone={() => onOpenChange(false)} />}
        {tab === 'security' && room.canManage && <SecurityTab room={room} onDone={() => onOpenChange(false)} />}
        {(tab === 'people' || !room.canManage) && <PeopleTab room={room} />}
      </DialogContent>
    </Dialog>
  )
}

function useRoomSaved(room: Room) {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  return (updated: Room) => {
    qc.setQueryData(queryKeys.room(orgId, room.id), updated)
    void qc.invalidateQueries({ queryKey: queryKeys.rooms(orgId) })
  }
}

function GeneralTab({ room, onDone }: { room: Room; onDone: () => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const saved = useRoomSaved(room)
  const [form, setForm] = useState({ name: room.name, topic: room.topic, admissionMinutes: room.admissionMinutes })
  const save = useMutation({
    mutationFn: () => api.updateRoom(orgId, room.id, form),
    onSuccess: (updated) => {
      saved(updated)
      onDone()
    },
  })
  const errors = fieldErrors(save.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  return (
    <form className="grid gap-4" onSubmit={submit}>
      {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
      <Field label={t('rooms.name')} error={errors.name}>
        <Input maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label={t('rooms.topic')} error={errors.topic}>
        <Input maxLength={250} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} />
      </Field>
      {room.hasPassword && (
        <AdmissionSelect
          value={form.admissionMinutes}
          onChange={(admissionMinutes) => setForm({ ...form, admissionMinutes })}
          error={errors.admissionMinutes}
        />
      )}
      <DialogFooter>
        <Button type="submit" disabled={save.isPending || !form.name.trim()}>
          {t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function SecurityTab({ room, onDone }: { room: Room; onDone: () => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const saved = useRoomSaved(room)
  const [access, setAccess] = useState<RoomAccess>(room.access)
  const [withPassword, setWithPassword] = useState(room.hasPassword)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const asksPassword = access === 'protected' || (access === 'restricted' && withPassword)
  // A room that had no password must get one; otherwise empty keeps the current one.
  const mustSetPassword = asksPassword && !room.hasPassword

  const save = useMutation({
    mutationFn: () =>
      api.setRoomSecurity(orgId, room.id, {
        access,
        password: asksPassword ? password : undefined,
        removePassword: !asksPassword && room.hasPassword,
      }),
    onSuccess: (updated) => {
      saved(updated)
      onDone()
    },
  })
  const errors = fieldErrors(save.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (asksPassword && password !== confirm) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    save.mutate()
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div className="flex gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <p>{t('rooms.securityWarning')}</p>
      </div>
      {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
      {errors.access && <Alert variant="error">{errors.access}</Alert>}
      <AccessChoices value={access} onChange={setAccess} />
      {access === 'restricted' && (
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={withPassword} onCheckedChange={(checked) => setWithPassword(checked === true)} />
          {t('rooms.requirePassword')}
        </label>
      )}
      {asksPassword && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={room.hasPassword ? t('rooms.newPassword') : t('rooms.password')}
            error={errors.password}
            hint={mustSetPassword ? t('rooms.passwordHint') : t('rooms.newPasswordHint')}
          >
            <Input
              type="password"
              autoComplete="new-password"
              icon={<KeyRoundIcon />}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label={t('rooms.passwordConfirm')} error={mismatch ? t('rooms.passwordMismatch') : undefined}>
            <Input
              type="password"
              autoComplete="new-password"
              icon={<KeyRoundIcon />}
              maxLength={128}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </div>
      )}
      {room.passwordChangedAt && (
        <p className="text-xs text-muted-foreground">{t('rooms.passwordChanged', { time: formatRelative(room.passwordChangedAt) })}</p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={save.isPending || (mustSetPassword && !password)}>
          {t('rooms.saveSecurity')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function PeopleTab({ room }: { room: Room }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const inside = useQuery({
    queryKey: queryKeys.roomMembers(orgId, room.id),
    queryFn: () => api.roomMembers(orgId, room.id),
    enabled: room.admitted || room.canManage,
  })
  const end = useMutation({
    mutationFn: (userId: string) => api.endAdmission(orgId, room.id, userId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.roomMembers(orgId, room.id) }),
  })

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h3 className="text-[13px] font-semibold">{t('rooms.participants')}</h3>
        {inside.isPending && <Spinner />}
        {inside.error && <Alert variant="error">{errorMessage(inside.error)}</Alert>}
        {end.error && <Alert variant="error">{errorMessage(end.error)}</Alert>}
        {inside.data?.length === 0 && <p className="text-[13px] text-muted-foreground">{t('rooms.nobodyInside')}</p>}
        {inside.data && inside.data.length > 0 && (
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {inside.data.map((p) => (
              <li key={p.user.id} className="flex items-center gap-3 px-3 py-2">
                <Avatar name={p.user.displayName} seed={p.user.id} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {p.user.displayName}
                    {p.user.id === room.createdBy && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">· {t('rooms.creator')}</span>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    <PersonAdmission expiresAt={p.expiresAt ?? null} />
                  </span>
                </span>
                {room.canManage && p.user.id !== me.user.id && (
                  <Button size="sm" variant="outline" disabled={end.isPending} onClick={() => end.mutate(p.user.id)}>
                    {t('rooms.endAdmission')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {room.canManage && room.access === 'restricted' && <AccessList room={room} />}
    </div>
  )
}

function PersonAdmission({ expiresAt }: { expiresAt: string | null }) {
  const t = useT()
  if (!expiresAt) return <>{t('rooms.lasting')}</>
  const minutes = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000))
  return <>{t('rooms.expiresIn', { time: formatMinutes(minutes) })}</>
}

/** A restricted room's access list. */
function AccessList({ room }: { room: Room }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const canPick = can(workspace, 'members.view')
  const list = useQuery({ queryKey: queryKeys.roomAccess(orgId, room.id), queryFn: () => api.roomAccess(orgId, room.id) })
  const [selected, setSelected] = useState<string[] | null>(null)
  const current = list.data?.map((p) => p.user.id).filter((id) => id !== room.createdBy && id !== me.user.id) ?? []
  const value = selected ?? current
  // The picker leaves out the caller; keep them if they are on the list.
  const meListed = list.data?.some((p) => p.user.id === me.user.id) ?? false
  const save = useMutation({
    mutationFn: () => api.setRoomAccess(orgId, room.id, meListed ? [...value, me.user.id] : value),
    onSuccess: (people) => {
      qc.setQueryData(queryKeys.roomAccess(orgId, room.id), people)
      void qc.invalidateQueries({ queryKey: queryKeys.roomMembers(orgId, room.id) })
      setSelected(null)
    },
  })
  if (!canPick) return null
  return (
    <section className="grid gap-2">
      <h3 className="text-[13px] font-semibold">{t('rooms.allowedPeople')}</h3>
      <p className="text-xs text-muted-foreground">{t('rooms.allowedHint')}</p>
      {list.isPending ? <Spinner /> : <MemberPicker selected={value} onChange={setSelected} />}
      {save.error && <Alert variant="error">{errorMessage(save.error)}</Alert>}
      <div className="flex justify-end">
        <Button size="sm" disabled={save.isPending || selected === null} onClick={() => save.mutate()}>
          {t('rooms.saveAccess')}
        </Button>
      </div>
    </section>
  )
}
