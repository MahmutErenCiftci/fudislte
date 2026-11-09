import type { AccessKey, RoleSummary } from '@fudislte/api-client'
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
  Spinner,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2Icon, CheckIcon, CopyIcon, KeyRoundIcon, MailIcon, PlusIcon, RadioTowerIcon, TimerIcon, UserIcon } from 'lucide-react'
import { type ChangeEvent, type FormEvent, useState } from 'react'

import { isLanguage, type Language, languages, translate, useLanguage, useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { formatDate, formatDateTime } from '../../lib/format'
import { can, canAssign } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { RequirePermission, SettingsCard } from './SettingsLayout'

/** IT tools: prepared accounts that open with a key, and the server-wide session lifetime. */
export function SecuritySettings() {
  const { me, workspace } = useWorkspace()
  const canKeys = can(workspace, 'members.invite')
  const admin = me.user.isInstanceAdmin
  return (
    <RequirePermission allowed={canKeys || admin}>
      <div className="grid max-w-3xl gap-6">
        {canKeys && <AccessKeys />}
        {admin && <SessionLifetime />}
        {admin && <Registration />}
      </div>
    </RequirePermission>
  )
}

function AccessKeys() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const keys = useQuery({ queryKey: queryKeys.accessKeys(orgId), queryFn: () => api.accessKeys(orgId) })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAccessKey(orgId, id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys(orgId) }),
  })

  return (
    <SettingsCard
      icon={KeyRoundIcon}
      title={t('keys.title')}
      description={t('keys.description')}
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          <PlusIcon />
          {t('keys.create')}
        </Button>
      }
    >
      <div className="grid gap-3">
        {revoke.error && <Alert variant="error">{errorMessage(revoke.error)}</Alert>}
        {keys.isPending && <Spinner />}
        {keys.data?.length === 0 && (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">{t('keys.empty')}</p>
        )}
        {keys.data && keys.data.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {keys.data.map((k) => (
              <KeyRow key={k.id} accessKey={k} onRevoke={() => revoke.mutate(k.id)} pending={revoke.isPending} />
            ))}
          </ul>
        )}
      </div>
      <CreateKeyDialog open={open} onOpenChange={setOpen} />
    </SettingsCard>
  )
}

function KeyRow({ accessKey: k, onRevoke, pending }: { accessKey: AccessKey; onRevoke: () => void; pending: boolean }) {
  const t = useT()
  return (
    <li className="flex items-center gap-3 px-4 py-3 text-[13px]">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium">
          {k.displayName} <span className="font-normal text-muted-foreground">· {k.email}</span>
        </p>
        <p className="truncate text-muted-foreground">
          {t('keys.meta', { role: k.role.name, creator: k.createdBy || t('invites.formerMember'), date: formatDate(k.expiresAt) })}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={onRevoke} disabled={pending}>
        {t('common.revoke')}
      </Button>
    </li>
  )
}

const VALIDITY_DAYS = [1, 3, 7, 14, 30, 90]

function defaultRole(roles: RoleSummary[]): string {
  return (roles.find((r) => r.key === 'employee') ?? roles[roles.length - 1])?.id ?? ''
}

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const language = useLanguage()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const queryClient = useQueryClient()
  const roles = useQuery({ queryKey: queryKeys.roles(orgId), queryFn: () => api.roles(orgId) })
  const assignable = (roles.data ?? []).filter((r) => canAssign(workspace.role, r))
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [roleId, setRoleId] = useState('')
  const [locale, setLocale] = useState<Language>(language)
  const [validDays, setValidDays] = useState(7)
  const [copied, setCopied] = useState<'key' | 'message' | null>(null)

  const create = useMutation({
    mutationFn: () =>
      api.createAccessKey(orgId, { displayName, email, roleId: roleId || defaultRole(assignable), locale, validDays }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys(orgId) }),
  })

  // Keep role, language and validity for the next person: IT often prepares several.
  const another = () => {
    create.reset()
    setDisplayName('')
    setEmail('')
    setCopied(null)
  }
  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) another()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  const copy = async (what: 'key' | 'message', text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(what)
  }
  const errors = fieldErrors(create.error)

  if (create.data) {
    const { accessKey, key } = create.data
    const signInUrl = `${window.location.origin}/login?key=1`
    // The message goes to the person, so it is written in their language.
    const lang = isLanguage(accessKey.locale) ? accessKey.locale : language
    const message = translate(lang, 'keys.message', {
      name: accessKey.displayName,
      workspace: workspace.organization.name,
      url: signInUrl,
      key,
      date: formatDate(accessKey.expiresAt),
    })
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t('keys.readyTitle')}</DialogTitle>
              <DialogDescription>
                {t('keys.readyText', { name: accessKey.displayName, date: formatDate(accessKey.expiresAt) })}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 rounded-lg border bg-muted/40 p-4 text-center">
              <code className="font-mono text-xl font-semibold tracking-wider select-all" aria-label={t('keys.key')}>
                {key}
              </code>
              <p className="text-xs text-muted-foreground">{t('keys.shownOnce')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void copy('key', key)}>
                {copied === 'key' ? <CheckIcon /> : <CopyIcon />}
                {copied === 'key' ? t('common.copied') : t('keys.copyKey')}
              </Button>
              <Button variant="outline" onClick={() => void copy('message', message)}>
                {copied === 'message' ? <CheckIcon /> : <MailIcon />}
                {copied === 'message' ? t('common.copied') : t('keys.copyMessage')}
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={another}>
                <PlusIcon />
                {t('keys.another')}
              </Button>
              <Button onClick={() => close(false)}>{t('common.done')}</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{t('keys.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {me.user.isInstanceAdmin ? t('keys.dialogDescription') : t('keys.dialogDescriptionDomains')}
            </DialogDescription>
          </DialogHeader>
          {formError(create.error) && <Alert variant="error">{formError(create.error)}</Alert>}
          <Field label={t('keys.name')} error={errors.displayName}>
            <Input icon={<UserIcon />} autoFocus autoComplete="off" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label={t('invites.email')} error={errors.email}>
            <Input
              icon={<MailIcon />}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('login.emailPlaceholder')}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1.5fr_1fr_1fr]">
            <Field label={t('invites.role')} error={errors.roleId}>
              <NativeSelect value={roleId || defaultRole(assignable)} onChange={(e) => setRoleId(e.target.value)}>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('keys.language')} error={errors.locale}>
              <NativeSelect value={locale} onChange={(e) => isLanguage(e.target.value) && setLocale(e.target.value)}>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('keys.validFor')} error={errors.validDays}>
              <NativeSelect value={validDays} onChange={(e) => setValidDays(Number(e.target.value))}>
                {VALIDITY_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {t('keys.days', { count: d })}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !email.trim() || !displayName.trim() || assignable.length === 0}>
              <KeyRoundIcon />
              {t('keys.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const PRESET_HOURS = [8, 24, 48, 168, 720]

/** "48 saat", "7 gün": whole days read better once a lifetime reaches a day. */
function useDuration() {
  const t = useT()
  return (hours: number) => (hours >= 24 && hours % 24 === 0 ? t('keys.days', { count: hours / 24 }) : t('session.hours', { count: hours }))
}

function SessionLifetime() {
  const t = useT()
  const duration = useDuration()
  const queryClient = useQueryClient()
  const policy = useQuery({ queryKey: queryKeys.sessionPolicy, queryFn: api.sessionPolicy })
  const [hours, setHours] = useState<string | null>(null)
  const value = hours ?? String(policy.data?.ttlHours ?? '')
  const save = useMutation({
    mutationFn: () => api.updateSessionPolicy(Number(value)),
    onSuccess: ({ policy: p }) => {
      queryClient.setQueryData(queryKeys.sessionPolicy, p)
      setHours(null)
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  const n = Number(value)
  const changed = policy.data !== undefined && value !== '' && n !== policy.data.ttlHours

  return (
    <SettingsCard icon={TimerIcon} title={t('session.title')} description={t('session.description')}>
      {policy.isPending && <Spinner />}
      {policy.error && <Alert variant="error">{errorMessage(policy.error)}</Alert>}
      {policy.data && (
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
          {save.data && !changed && <Alert>{t('session.saved', { count: save.data.endedSessions })}</Alert>}
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('session.presets')}>
            {PRESET_HOURS.map((h) => (
              <Button
                key={h}
                type="button"
                size="sm"
                variant={n === h ? 'default' : 'outline'}
                onClick={() => {
                  save.reset()
                  setHours(String(h))
                }}
              >
                {duration(h)}
                {h === 48 && ` · ${t('session.default')}`}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr] sm:items-start">
            <Field label={t('session.hoursLabel')} error={fieldErrors(save.error).ttlHours}>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={2160}
                value={value}
                onChange={(e) => {
                  save.reset()
                  setHours(e.target.value)
                }}
              />
            </Field>
            <p className="text-[13px] text-muted-foreground sm:mt-[30px]">
              {Number.isInteger(n) && n > 0 ? t('session.current', { duration: duration(n) }) : t('session.range')}
            </p>
          </div>
          {changed && n < policy.data.ttlHours && <Alert>{t('session.shorterWarning')}</Alert>}
          <div className="flex justify-end">
            <Button type="submit" disabled={!changed || save.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      )}
    </SettingsCard>
  )
}

/**
 * Opt-in registration with the FUDISLTE project. The card shows exactly what a report
 * contains; nothing is sent until an instance administrator turns it on.
 */
function Registration() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const queryClient = useQueryClient()
  const reg = useQuery({
    queryKey: queryKeys.registration,
    queryFn: api.registration,
    // The first report goes out in the background; poll briefly until it is recorded.
    refetchInterval: (q) => (q.state.data?.enabled && !q.state.data.lastSentAt && !q.state.data.lastError ? 2000 : false),
  })
  const [draft, setDraft] = useState<{ organizationName: string; contactEmail: string } | null>(null)
  const current = reg.data
  const values = draft ?? {
    organizationName: current?.organizationName || workspace.organization.name,
    contactEmail: current?.contactEmail || me.user.email,
  }
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.updateRegistration(enabled ? { enabled, ...values } : { enabled }),
    onSuccess: (r) => {
      queryClient.setQueryData(queryKeys.registration, r)
      setDraft(null)
    },
  })
  if (!current?.available) return null

  const errors = fieldErrors(save.error)
  const edit = (key: 'organizationName' | 'contactEmail') => (e: ChangeEvent<HTMLInputElement>) => {
    save.reset()
    setDraft({ ...values, [key]: e.target.value })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate(true)
  }

  return (
    <SettingsCard
      icon={RadioTowerIcon}
      title={t('registration.title')}
      description={t('registration.description')}
      actions={current.enabled ? <Badge variant="success">{t('registration.on')}</Badge> : <Badge>{t('registration.off')}</Badge>}
    >
      <form className="grid gap-4" onSubmit={submit} noValidate>
        {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
        {current.enabled && current.lastError && (
          <Alert variant="error">{t('registration.failed', { error: current.lastError })}</Alert>
        )}
        <p className="text-[13px] font-medium">{t('registration.sent')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('registration.organization')} error={errors.organizationName}>
            <Input icon={<Building2Icon />} value={values.organizationName} onChange={edit('organizationName')} />
          </Field>
          <Field label={t('registration.contact')} error={errors.contactEmail}>
            <Input icon={<MailIcon />} type="email" value={values.contactEmail} onChange={edit('contactEmail')} />
          </Field>
        </div>
        <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-3 text-[13px]">
          <div>
            <dt className="text-muted-foreground">{t('registration.users')}</dt>
            <dd className="font-medium">{current.userCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('registration.version')}</dt>
            <dd className="font-medium">{current.version}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">{t('registration.never')}</p>
        {current.enabled && (
          <p className="text-[13px] text-muted-foreground">
            {current.lastSentAt ? t('registration.lastSent', { date: formatDateTime(current.lastSentAt) }) : t('registration.pending')}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {current.enabled ? (
            <>
              <Button type="button" variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending}>
                {t('registration.turnOff')}
              </Button>
              <Button type="submit" disabled={save.isPending || draft === null}>
                {t('common.save')}
              </Button>
            </>
          ) : (
            <Button type="submit" disabled={save.isPending}>
              <RadioTowerIcon />
              {t('registration.turnOn')}
            </Button>
          )}
        </div>
      </form>
    </SettingsCard>
  )
}
