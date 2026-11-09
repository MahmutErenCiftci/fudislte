import { Alert, Button, Field, Input, NativeSelect } from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2Icon, HistoryIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { RequirePermission, SettingsCard } from './SettingsLayout'

export function WorkspaceSettings() {
  const { workspace } = useWorkspace()
  return (
    <RequirePermission allowed={can(workspace, 'org.manage')}>
      <div className="grid max-w-3xl gap-6">
        <WorkspaceForm />
        <Retention />
      </div>
    </RequirePermission>
  )
}

const retentionChoices = [30, 90, 180, 365, 730, 1825]

/** Workspace message retention (increment 2.6): older messages and files are deleted. */
function Retention() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const queryClient = useQueryClient()
  const current = useQuery({ queryKey: queryKeys.retention(orgId), queryFn: () => api.retention(orgId) })
  const [choice, setChoice] = useState<string | null>(null)
  const value = choice ?? (current.data ? String(current.data) : 'forever')
  const save = useMutation({
    mutationFn: () => api.setRetention(orgId, value === 'forever' ? null : Number(value)),
    onSuccess: (days) => {
      queryClient.setQueryData(queryKeys.retention(orgId), days)
      setChoice(null)
    },
  })
  const changed = choice !== null && choice !== (current.data ? String(current.data) : 'forever')
  return (
    <SettingsCard icon={HistoryIcon} title={t('retention.title')} description={t('retention.description')}>
      {save.error && <Alert variant="error" className="mb-4">{errorMessage(save.error)}</Alert>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('retention.keep')} className="min-w-64">
          <NativeSelect value={value} onChange={(e) => setChoice(e.target.value)} disabled={current.isPending}>
            <option value="forever">{t('retention.forever')}</option>
            {retentionChoices.map((d) => (
              <option key={d} value={d}>
                {t('retention.days', { count: d })}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button onClick={() => save.mutate()} disabled={!changed || save.isPending}>
          {t('common.save')}
        </Button>
        {save.isSuccess && !changed && <span className="text-[13px] text-muted-foreground">{t('common.saved')}</span>}
      </div>
      {value !== 'forever' && (
        <Alert className="mt-4">{t('retention.warning', { count: Number(value) })}</Alert>
      )}
    </SettingsCard>
  )
}

function WorkspaceForm() {
  const t = useT()
  const { workspace } = useWorkspace()
  const org = workspace.organization
  const queryClient = useQueryClient()
  const [name, setName] = useState(org.name)
  const save = useMutation({
    mutationFn: () => api.updateOrganization(org.id, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  return (
    <SettingsCard icon={Building2Icon} title={t('general.title')} description={t('general.description')}>
      <form className="grid gap-4" onSubmit={submit}>
        {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('general.name')} error={fieldErrors(save.error).name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('general.address')} hint={t('general.addressHint', { date: formatDate(org.createdAt) })}>
            <Input value={`${window.location.host}/w/${org.slug}`} readOnly disabled />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-3">
          {save.isSuccess && <span className="text-[13px] text-muted-foreground">{t('common.saved')}</span>}
          <Button type="submit" disabled={save.isPending || name.trim() === org.name}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </SettingsCard>
  )
}
