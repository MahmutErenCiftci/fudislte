import type { Member, RoleSummary } from '@fudislte/api-client'
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Input,
  NativeSelect,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  GlobeLockIcon,
  MailIcon,
  MoreVerticalIcon,
  SearchIcon,
  ShieldCheckIcon,
  UserMinusIcon,
  UserRoundCheckIcon,
  UserRoundXIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { formatDate, formatRelative } from '../../lib/format'
import { can, canAssign, outranks } from '../../lib/permissions'
import { roleStyle } from '../../lib/roles'
import { useWorkspace } from '../../shell/context'
import { RequirePermission, SettingsCard } from './SettingsLayout'
import { searchKey } from '../../lib/search'

const PAGE_SIZE = 20

export function UsersSettings() {
  const { workspace } = useWorkspace()
  const [inviteOpen, setInviteOpen] = useState(false)
  const canView = can(workspace, 'members.view')
  const canInvite = can(workspace, 'members.invite')
  return (
    <RequirePermission allowed={canView || canInvite || can(workspace, 'members.manage')}>
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_360px]">
        {canView && <UsersTable onInvite={canInvite ? () => setInviteOpen(true) : undefined} />}
        <div className="grid content-start gap-6">
          {canInvite && <Invitations onInvite={canView ? undefined : () => setInviteOpen(true)} />}
          {can(workspace, 'org.manage') && <AccessSummary />}
        </div>
      </div>
      {canInvite && <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />}
    </RequirePermission>
  )
}

function useRoles() {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  return useQuery({ queryKey: queryKeys.roles(orgId), queryFn: () => api.roles(orgId) })
}

function RoleBadge({ role }: { role: { key: string; name: string } }) {
  const { tone, icon: Icon } = roleStyle(role.key)
  return (
    <Badge variant={tone}>
      <Icon />
      {role.name}
    </Badge>
  )
}

function UsersTable({ onInvite }: { onInvite?: () => void }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const queryClient = useQueryClient()
  const members = useQuery({ queryKey: queryKeys.members(orgId), queryFn: () => api.members(orgId) })
  const roles = useRoles()
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [page, setPage] = useState(0)
  const [changing, setChanging] = useState<Member | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)
  const [disabling, setDisabling] = useState<Member | null>(null)
  // Disabling works on the account, across the server: instance administrators only.
  const instanceAdmin = me.user.isInstanceAdmin
  const canManage = can(workspace, 'members.manage') || instanceAdmin

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.members(orgId) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.roles(orgId) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.me })
  }
  const setDisabled = useMutation({
    mutationFn: ({ userId, disabled }: { userId: string; disabled: boolean }) => api.setMemberDisabled(orgId, userId, disabled),
    onSuccess: () => setDisabling(null),
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(orgId, userId),
    onSuccess: () => setRemoving(null),
    onSettled: refresh,
  })

  const q = searchKey(query.trim())
  const filtered = (members.data ?? []).filter(
    (m) =>
      (!roleFilter || m.role.id === roleFilter) &&
      (!q || [m.user.displayName, m.user.email, m.role.name].some((v) => searchKey(v).includes(q))),
  )
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const rows = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const manageable = (m: Member) =>
    can(workspace, 'members.manage') && m.user.id !== me.user.id && outranks(workspace.role, m.role.position)
  const hasActions = (m: Member) => manageable(m) || (instanceAdmin && m.user.id !== me.user.id)

  return (
    <SettingsCard
      icon={UsersIcon}
      title={t('users.title')}
      description={t('users.description')}
      actions={
        onInvite && (
          <Button onClick={onInvite}>
            <UserPlusIcon />
            {t('users.invite')}
          </Button>
        )
      }
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            icon={<SearchIcon />}
            aria-label={t('users.search')}
            placeholder={t('users.search')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
          />
        </div>
        <NativeSelect
          aria-label={t('users.allRoles')}
          className="sm:w-52"
          value={roleFilter}
          onChange={(e) => {
            setRoleFilter(e.target.value)
            setPage(0)
          }}
        >
          <option value="">{t('users.allRoles')}</option>
          {roles.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </NativeSelect>
      </div>

      {members.isPending && <Spinner />}
      {members.error && <Alert variant="error">{errorMessage(members.error)}</Alert>}
      {members.data && (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('users.colUser')}</TableHead>
                <TableHead className="w-48">{t('users.colRole')}</TableHead>
                <TableHead className="w-32">{t('users.colJoined')}</TableHead>
                {canManage && <TableHead className="w-36">{t('users.colLastActive')}</TableHead>}
                {canManage && <TableHead className="w-16 text-right">{t('users.colActions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    {t('users.empty')}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((m) => (
                <TableRow key={m.user.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar name={m.user.displayName} seed={m.user.id} size="md" online={m.user.id === me.user.id} />
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium">
                          {m.user.displayName}
                          {m.user.id === me.user.id && <span className="font-normal text-muted-foreground"> {t('users.you')}</span>}
                          {m.disabled && (
                            <Badge variant="destructive" className="ml-2 align-middle">
                              {t('users.disabled')}
                            </Badge>
                          )}
                        </p>
                        <p className="truncate text-muted-foreground">{m.user.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={m.role} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(m.joinedAt)}</TableCell>
                  {canManage && (
                    <TableCell className="text-muted-foreground">{m.lastActiveAt ? formatRelative(m.lastActiveAt) : '—'}</TableCell>
                  )}
                  {canManage && (
                    <TableCell className="text-right">
                      {hasActions(m) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="icon" aria-label={t('users.colActions')}>
                              <MoreVerticalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {manageable(m) && (
                              <DropdownMenuItem onSelect={() => setChanging(m)}>
                                <ShieldCheckIcon />
                                {t('users.changeRole')}
                              </DropdownMenuItem>
                            )}
                            {instanceAdmin &&
                              (m.disabled ? (
                                <DropdownMenuItem onSelect={() => setDisabled.mutate({ userId: m.user.id, disabled: false })}>
                                  <UserRoundCheckIcon />
                                  {t('users.enable')}
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem variant="destructive" onSelect={() => setDisabling(m)}>
                                  <UserRoundXIcon />
                                  {t('users.disable')}
                                </DropdownMenuItem>
                              ))}
                            {manageable(m) && (
                              <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(m)}>
                                <UserMinusIcon />
                                {t('users.remove')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {filtered.length > 0 && (
        <div className="mt-3 flex items-center justify-between text-[13px] text-muted-foreground">
          <span>
            {t('users.showing', {
              from: current * PAGE_SIZE + 1,
              to: Math.min((current + 1) * PAGE_SIZE, filtered.length),
              total: filtered.length,
            })}
          </span>
          {pages > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" aria-label={t('users.previous')} disabled={current === 0} onClick={() => setPage(current - 1)}>
                <ChevronLeftIcon />
              </Button>
              <span className="px-2 font-medium text-foreground">
                {current + 1} / {pages}
              </span>
              <Button variant="outline" size="icon" aria-label={t('users.next')} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                <ChevronRightIcon />
              </Button>
            </div>
          )}
        </div>
      )}

      {setDisabled.error && !disabling && <Alert variant="error" className="mt-3">{errorMessage(setDisabled.error)}</Alert>}
      <Dialog
        open={disabling !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDisabling(null)
            setDisabled.reset()
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('users.disableTitle', { name: disabling?.user.displayName ?? '' })}</DialogTitle>
            <DialogDescription>{t('users.disableText')}</DialogDescription>
          </DialogHeader>
          {setDisabled.error && <Alert variant="error">{errorMessage(setDisabled.error)}</Alert>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisabling(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={setDisabled.isPending}
              onClick={() => disabling && setDisabled.mutate({ userId: disabling.user.id, disabled: true })}
            >
              {t('users.disable')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {changing && <ChangeRoleDialog member={changing} onClose={() => setChanging(null)} onChanged={refresh} />}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null)
            remove.reset()
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('users.removeTitle', { name: removing?.user.displayName ?? '' })}</DialogTitle>
            <DialogDescription>{t('users.removeText')}</DialogDescription>
          </DialogHeader>
          {remove.error && <Alert variant="error">{errorMessage(remove.error)}</Alert>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing.user.id)}>
              {t('users.removeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  )
}

function ChangeRoleDialog({ member, onClose, onChanged }: { member: Member; onClose: () => void; onChanged: () => Promise<void> }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const roles = useRoles()
  const [roleId, setRoleId] = useState(member.role.id)
  const assignable = (roles.data ?? []).filter((r) => r.id === member.role.id || canAssign(workspace.role, r))
  const change = useMutation({
    mutationFn: () => api.updateMemberRole(orgId, member.user.id, roleId),
    onSuccess: async () => {
      await onChanged()
      onClose()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    change.mutate()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('users.changeRoleTitle', { name: member.user.displayName })}</DialogTitle>
            <DialogDescription>{t('users.changeRoleDescription')}</DialogDescription>
          </DialogHeader>
          {change.error && <Alert variant="error">{errorMessage(change.error)}</Alert>}
          <Field label={t('users.colRole')}>
            <NativeSelect value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {assignable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={change.isPending || roleId === member.role.id}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Invitations({ onInvite }: { onInvite?: () => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const queryClient = useQueryClient()
  const invitations = useQuery({ queryKey: queryKeys.invitations(orgId), queryFn: () => api.invitations(orgId) })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvitation(orgId, id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.invitations(orgId) }),
  })

  return (
    <SettingsCard
      icon={MailIcon}
      title={t('invites.title')}
      description={t('invites.description')}
      actions={
        onInvite && (
          <Button size="sm" onClick={onInvite}>
            <UserPlusIcon />
            {t('users.invite')}
          </Button>
        )
      }
    >
      {revoke.error && <Alert variant="error">{errorMessage(revoke.error)}</Alert>}
      {invitations.isPending && <Spinner />}
      {invitations.data?.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">{t('invites.empty')}</p>
      )}
      {invitations.data && invitations.data.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {invitations.data.map((inv) => (
            <li key={inv.id} className="flex items-center gap-3 px-4 py-3 text-[13px]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{inv.email}</p>
                <p className="truncate text-muted-foreground">
                  {t('invites.meta', {
                    role: inv.role.name,
                    inviter: inv.invitedBy || t('invites.formerMember'),
                    date: formatDate(inv.expiresAt),
                  })}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => revoke.mutate(inv.id)} disabled={revoke.isPending}>
                {t('common.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}

/** How people get into the workspace: invitations only, or also by company domain. */
function AccessSummary() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const domains = useQuery({ queryKey: queryKeys.domains(orgId), queryFn: () => api.domains(orgId) })
  if (!domains.data) return null
  // Only verified domains let people in.
  const verified = domains.data.filter((d) => d.verifiedAt)
  const withDomains = verified.length > 0
  return (
    <SettingsCard icon={GlobeLockIcon} title={t('access.summaryTitle')}>
      <div className="grid gap-3">
        <div className="flex items-start gap-3 rounded-lg bg-primary-soft/60 p-3">
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="text-[13px]">
            <p className="font-semibold">{withDomains ? t('access.withDomains') : t('access.inviteOnly')}</p>
            <p className="text-muted-foreground">
              {withDomains
                ? t('access.withDomainsText', { domains: verified.map((d) => `@${d.domain}`).join(', ') })
                : t('access.inviteOnlyText')}
            </p>
          </div>
        </div>
        <Link
          to={`/w/${workspace.organization.slug}/settings/access`}
          className="flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
        >
          {t('access.manage')}
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>
    </SettingsCard>
  )
}

function defaultRole(roles: RoleSummary[]): string {
  return (roles.find((r) => r.key === 'employee') ?? roles[roles.length - 1])?.id ?? ''
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const queryClient = useQueryClient()
  const roles = useRoles()
  const assignable = (roles.data ?? []).filter((r) => canAssign(workspace.role, r))
  const [email, setEmail] = useState('')
  const [roleId, setRoleId] = useState('')
  const [copied, setCopied] = useState(false)

  const create = useMutation({
    mutationFn: () => api.createInvitation(orgId, email, roleId || defaultRole(assignable)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invitations(orgId) }),
  })
  const link = create.data ? `${window.location.origin}/invite/${create.data.token}` : ''

  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) {
      create.reset()
      setEmail('')
      setRoleId('')
      setCopied(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
  }
  const errors = fieldErrors(create.error)

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {create.data ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t('invites.sentTitle')}</DialogTitle>
              <DialogDescription>
                {t('invites.sentText', { email: create.data.invitation.email, date: formatDate(create.data.invitation.expiresAt) })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={link} aria-label={t('invites.link')} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
              <Button variant="outline" onClick={copy}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>{t('common.done')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>{t('invites.dialogTitle')}</DialogTitle>
              <DialogDescription>{t('invites.dialogDescription')}</DialogDescription>
            </DialogHeader>
            {formError(create.error) && <Alert variant="error">{formError(create.error)}</Alert>}
            <Field label={t('invites.email')} error={errors.email}>
              <Input
                icon={<MailIcon />}
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
              />
            </Field>
            <Field label={t('invites.role')} error={errors.roleId}>
              <NativeSelect value={roleId || defaultRole(assignable)} onChange={(e) => setRoleId(e.target.value)}>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={create.isPending || !email || assignable.length === 0}>
                {t('invites.send')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
