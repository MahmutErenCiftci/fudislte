import type { Channel } from '@fudislte/api-client'
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
  Spinner,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HashIcon, UserPlusIcon, XIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { updateChannel } from './cache'
import { MemberPicker } from './MemberPicker'

interface DialogProps {
  channel: Channel
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Whether the signed-in member may rename the channel and remove its members. */
export function useCanManageChannel(channel: Channel) {
  const { me, workspace } = useWorkspace()
  return can(workspace, 'channels.manage') || channel.createdBy === me.user.id
}

export function ChannelMembersDialog({ channel, open, onOpenChange }: DialogProps) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  // Direct conversations keep the people they started with.
  const direct = channel.kind === 'direct'
  const canManage = useCanManageChannel(channel) && !direct
  const canAdd = !direct && channel.joined && can(workspace, 'members.view')
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const members = useQuery({
    queryKey: queryKeys.channelMembers(orgId, channel.id),
    queryFn: () => api.channelMembers(orgId, channel.id),
    enabled: open,
  })
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.channelMembers(orgId, channel.id) }),
      qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) }),
      qc.invalidateQueries({ queryKey: queryKeys.channel(orgId, channel.id) }),
    ])
  const add = useMutation({
    mutationFn: () => api.addChannelMembers(orgId, channel.id, selected),
    onSuccess: async () => {
      await refresh()
      setSelected([])
      setAdding(false)
    },
  })
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeChannelMember(orgId, channel.id, userId),
    onSuccess: refresh,
  })
  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) {
      setAdding(false)
      setSelected([])
      add.reset()
      remove.reset()
    }
  }
  const error = add.error ?? remove.error

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {adding ? t('chat.addPeople') : direct ? t('dm.participants') : t('chat.membersTitle', { name: channel.name })}
          </DialogTitle>
          <DialogDescription>
            {channel.isDefault ? t('chat.defaultNote') : t('chat.members', { count: channel.memberCount })}
          </DialogDescription>
        </DialogHeader>
        {error && <Alert variant="error">{errorMessage(error)}</Alert>}
        {adding ? (
          <MemberPicker selected={selected} onChange={setSelected} exclude={members.data?.map((m) => m.user.id) ?? []} />
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-lg border">
            {members.isPending && (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            )}
            <ul className="divide-y">
              {members.data?.map((m) => {
                const self = m.user.id === me.user.id
                return (
                  <li key={m.user.id} className="flex items-center gap-3 px-3 py-2">
                    <Avatar name={m.user.displayName} seed={m.user.id} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {m.user.displayName} {self && <span className="font-normal text-muted-foreground">{t('chat.you')}</span>}
                    </span>
                    {canManage && !self && !channel.isDefault && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${t('chat.removeMember')}: ${m.user.displayName}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(m.user.id)}
                      >
                        <XIcon />
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <DialogFooter>
          {adding ? (
            <>
              <Button variant="outline" onClick={() => setAdding(false)}>
                {t('common.cancel')}
              </Button>
              <Button disabled={selected.length === 0 || add.isPending} onClick={() => add.mutate()}>
                {t('chat.add')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                {t('common.close')}
              </Button>
              {canAdd && (
                <Button onClick={() => setAdding(true)}>
                  <UserPlusIcon />
                  {t('chat.addPeople')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function EditChannelDialog({ channel, open, onOpenChange }: DialogProps) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const [form, setForm] = useState({ name: channel.name, topic: channel.topic })
  const save = useMutation({
    mutationFn: () => api.updateChannel(orgId, channel.id, form),
    onSuccess: async (updated) => {
      updateChannel(qc, orgId, channel.id, (c) => ({ ...c, name: updated.name, topic: updated.topic }))
      await qc.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
      onOpenChange(false)
    },
  })
  const errors = fieldErrors(save.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (o) setForm({ name: channel.name, topic: channel.topic })
        else save.reset()
      }}
    >
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('chat.edit')}</DialogTitle>
          </DialogHeader>
          {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
          <Field label={t('chat.name')} error={errors.name} hint={t('chat.nameHint')}>
            <Input
              autoFocus
              icon={<HashIcon />}
              maxLength={60}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label={t('chat.topic')} error={errors.topic}>
            <Input
              maxLength={250}
              placeholder={t('chat.topicPlaceholder')}
              value={form.topic}
              onChange={(e) => setForm({ ...form, topic: e.target.value })}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending || !form.name.trim()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A small yes/no dialog for destructive actions. */
export function ConfirmDialog({
  open,
  title,
  text,
  action,
  pending,
  error,
  onConfirm,
  onOpenChange,
}: {
  open: boolean
  title: string
  text: string
  action: string
  pending: boolean
  error: unknown
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        {!!error && <Alert variant="error">{errorMessage(error)}</Alert>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
