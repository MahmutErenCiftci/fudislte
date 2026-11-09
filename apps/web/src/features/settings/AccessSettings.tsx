import type { Domain } from '@fudislte/api-client'
import { Alert, Badge, Button, Field, Input, NativeSelect, Spinner } from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AtSignIcon, CheckIcon, CopyIcon, GlobeLockIcon, ShieldCheckIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { can, canAssign, MANAGEMENT_PERMISSIONS } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { RequirePermission, SettingsCard } from './SettingsLayout'

export function AccessSettings() {
  const { workspace } = useWorkspace()
  return (
    <RequirePermission allowed={can(workspace, 'org.manage')}>
      <EmailDomains />
    </RequirePermission>
  )
}

/** Company email domains whose people join automatically on their first sign-in. */
function EmailDomains() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const queryClient = useQueryClient()
  const domains = useQuery({ queryKey: queryKeys.domains(orgId), queryFn: () => api.domains(orgId) })
  const roles = useQuery({ queryKey: queryKeys.roles(orgId), queryFn: () => api.roles(orgId) })
  const [domain, setDomain] = useState('')
  const [roleId, setRoleId] = useState('')

  const eligibleRoles = (roles.data ?? []).filter(
    (r) => canAssign(workspace.role, r) && !r.permissions.some((p) => MANAGEMENT_PERMISSIONS.includes(p)),
  )
  const defaultRoleId = (eligibleRoles.find((r) => r.key === 'employee') ?? eligibleRoles[eligibleRoles.length - 1])?.id ?? ''
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.domains(orgId) })

  const add = useMutation({
    mutationFn: () => api.addDomain(orgId, domain, roleId || defaultRoleId),
    onSuccess: () => {
      setDomain('')
      return refresh()
    },
  })
  const remove = useMutation({ mutationFn: (d: string) => api.removeDomain(orgId, d), onSettled: refresh })
  const verify = useMutation({
    mutationFn: (d: string) => api.verifyDomain(orgId, d),
    onSuccess: (list) => queryClient.setQueryData(queryKeys.domains(orgId), list),
  })
  const errors = fieldErrors(add.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    add.mutate()
  }

  return (
    <SettingsCard icon={GlobeLockIcon} title={t('access.title')} description={t('access.description')} className="max-w-3xl">
      <div className="grid gap-4">
        {(formError(add.error) || remove.error || verify.error) && (
          <Alert variant="error">{formError(add.error) ?? errorMessage(remove.error ?? verify.error)}</Alert>
        )}
        {domains.isPending && <Spinner />}
        {domains.data && domains.data.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {domains.data.map((d) => (
              <li key={d.domain} className="grid gap-3 px-4 py-3">
                <div className="flex items-center gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
                  <AtSignIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-[14px] font-medium">
                    {d.domain}
                    {d.verifiedAt ? (
                      <Badge variant="success">
                        <ShieldCheckIcon />
                        {t('access.verified')}
                      </Badge>
                    ) : (
                      <Badge variant="amber">{t('access.pending')}</Badge>
                    )}
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    {t('access.joinsAs', { role: d.role.name, date: formatDate(d.createdAt) })}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(d.domain)} disabled={remove.isPending}>
                  {t('common.remove')}
                </Button>
                </div>
                {!d.verifiedAt && (
                  <VerifyDomain domain={d} pending={verify.isPending} onVerify={() => verify.mutate(d.domain)} />
                )}
              </li>
            ))}
          </ul>
        )}
        <form className="grid gap-3 rounded-lg border border-dashed p-4 sm:grid-cols-[1fr_12rem_auto] sm:items-start" onSubmit={submit} noValidate>
          <Field label={t('access.domain')} error={errors.domain}>
            <Input
              icon={<AtSignIcon />}
              placeholder={t('access.domainPlaceholder')}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label={t('access.roleOnJoin')} error={errors.roleId}>
            <NativeSelect value={roleId || defaultRoleId} onChange={(e) => setRoleId(e.target.value)}>
              {eligibleRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button type="submit" className="sm:mt-[22px]" disabled={add.isPending || !domain.trim() || eligibleRoles.length === 0}>
            {t('access.add')}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t('access.note')}</p>
      </div>
    </SettingsCard>
  )
}

/** How to prove control of a domain: publish the TXT record, then check it. */
function VerifyDomain({ domain, pending, onVerify }: { domain: Domain; pending: boolean; onVerify: () => void }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = () =>
    void navigator.clipboard?.writeText(domain.record).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  return (
    <div className="grid gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-[13px] sm:ml-13 dark:border-amber-500/30 dark:bg-amber-500/10">
      <p>{t('access.verifyText', { domain: domain.domain })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1.5 font-mono text-xs">{domain.record}</code>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
        <Button size="sm" onClick={onVerify} disabled={pending}>
          {t('access.verify')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('access.verifyHint', { domain: domain.domain })}</p>
    </div>
  )
}
