import type { Permission, RoleInput, RoleSummary } from '@fudislte/api-client'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  Spinner,
  Textarea,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LockIcon, PlusIcon, ShieldCheckIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { can, isOwner, outranks } from '../../lib/permissions'
import { roleStyle } from '../../lib/roles'
import { useWorkspace } from '../../shell/context'
import { RequirePermission, SettingsCard } from './SettingsLayout'

export function RolesSettings() {
  const { workspace } = useWorkspace()
  return (
    <RequirePermission allowed={can(workspace, 'roles.manage')}>
      <RoleList />
    </RequirePermission>
  )
}

type Editing = { mode: 'create' } | { mode: 'edit'; role: RoleSummary } | null

function RoleList() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const roles = useQuery({ queryKey: queryKeys.roles(orgId), queryFn: () => api.roles(orgId) })
  const permissions = useQuery({ queryKey: queryKeys.permissions, queryFn: api.permissions, staleTime: Infinity })
  const [editing, setEditing] = useState<Editing>(null)
  const nameOf = (p: Permission) => permissions.data?.find((i) => i.key === p)?.name ?? p

  return (
    <SettingsCard
      icon={ShieldCheckIcon}
      title={t('roles.title')}
      description={t('roles.description')}
      actions={
        <Button onClick={() => setEditing({ mode: 'create' })}>
          <PlusIcon />
          {t('roles.create')}
        </Button>
      }
    >
      {roles.isPending && <Spinner />}
      {roles.error && <Alert variant="error">{errorMessage(roles.error)}</Alert>}
      {roles.data && (
        <ul className="divide-y rounded-lg border">
          {roles.data.map((r) => {
            const editable = !r.isSystem && outranks(workspace.role, r.position)
            const { tone, icon: Icon } = roleStyle(r.key)
            return (
              <li key={r.id} className="flex items-start gap-4 px-4 py-3.5">
                <Badge variant={tone} className="mt-0.5 size-9 justify-center rounded-lg p-0 [&_svg]:size-4!">
                  <Icon />
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                    {r.name}
                    {r.isSystem && <LockIcon aria-label={t('roles.builtIn')} className="size-3.5 text-muted-foreground" />}
                    <span className="text-[13px] font-normal text-muted-foreground">
                      {t('roles.rank', { rank: r.position })} · {t('roles.members', { count: r.memberCount })}
                    </span>
                  </p>
                  {r.description && <p className="text-[13px] text-muted-foreground">{r.description}</p>}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.permissions.length === 0 && <Badge variant="outline">{t('roles.noPermissions')}</Badge>}
                    {r.permissions.map((p) => (
                      <Badge key={p}>{nameOf(p)}</Badge>
                    ))}
                  </div>
                </div>
                {editable && (
                  <Button variant="outline" size="sm" onClick={() => setEditing({ mode: 'edit', role: r })}>
                    {t('common.edit')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {editing && <RoleDialog editing={editing} onClose={() => setEditing(null)} />}
    </SettingsCard>
  )
}

function RoleDialog({ editing, onClose }: { editing: NonNullable<Editing>; onClose: () => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const queryClient = useQueryClient()
  const permissions = useQuery({ queryKey: queryKeys.permissions, queryFn: api.permissions, staleTime: Infinity })
  const existing = editing.mode === 'edit' ? editing.role : undefined
  const actorIsOwner = isOwner(workspace.role)
  const maxRank = actorIsOwner ? 99 : workspace.role.position - 1

  const [form, setForm] = useState({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    position: String(existing?.position ?? Math.min(25, maxRank)),
    permissions: existing?.permissions ?? ([] as Permission[]),
  })

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.roles(orgId) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.members(orgId) })
    onClose()
  }
  const save = useMutation({
    mutationFn: () => {
      const input: RoleInput = { ...form, position: Number(form.position) }
      return existing ? api.updateRole(orgId, existing.id, input) : api.createRole(orgId, input)
    },
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: () => api.deleteRole(orgId, existing!.id), onSuccess: done })
  const errors = fieldErrors(save.error)

  const toggle = (p: Permission, on: boolean) =>
    setForm({ ...form, permissions: on ? [...form.permissions, p] : form.permissions.filter((x) => x !== p) })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{existing ? t('roles.editTitle', { name: existing.name }) : t('roles.create')}</DialogTitle>
            <DialogDescription>{t('roles.dialogDescription', { max: maxRank })}</DialogDescription>
          </DialogHeader>
          {(formError(save.error) || remove.error) && <Alert variant="error">{formError(save.error) ?? errorMessage(remove.error)}</Alert>}
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field label={t('roles.name')} error={errors.name}>
              <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t('roles.rankLabel')} error={errors.position}>
              <Input type="number" min={1} max={maxRank} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
            </Field>
          </div>
          <Field label={t('roles.descriptionLabel')} error={errors.description}>
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <fieldset className="grid gap-2.5">
            <legend className="mb-2 text-[13px] font-medium">{t('roles.permissions')}</legend>
            {errors.permissions && <p className="text-xs text-destructive">{errors.permissions}</p>}
            {permissions.data?.map((p) => {
              const grantable = actorIsOwner || workspace.role.permissions.includes(p.key)
              const id = `perm-${p.key}`
              return (
                <div key={p.key} className="flex items-start gap-2.5">
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={form.permissions.includes(p.key)}
                    disabled={!grantable}
                    onCheckedChange={(v) => toggle(p.key, v === true)}
                  />
                  <Label htmlFor={id} className="grid gap-0.5 leading-snug font-normal">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{p.description}</span>
                  </Label>
                </div>
              )
            })}
          </fieldset>
          <DialogFooter className="sm:justify-between">
            <div>
              {existing && existing.memberCount === 0 && (
                <Button variant="ghost" className="text-destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
                  {t('roles.delete')}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={save.isPending || !form.name.trim()}>
                {existing ? t('roles.save') : t('roles.create')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
