import type { ChannelVisibility } from '@fudislte/api-client'
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
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HashIcon, LockIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'

import { useT } from '../../i18n'
import { api, fieldErrors, formError, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { MemberPicker } from './MemberPicker'
import { normalizeChannelName } from './text'

const empty = { name: '', topic: '', visibility: 'public' as ChannelVisibility, memberIds: [] as string[] }

export function CreateChannelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form, setForm] = useState(empty)
  const canPickMembers = can(workspace, 'members.view')

  const close = () => {
    onOpenChange(false)
    setForm(empty)
    create.reset()
  }
  const create = useMutation({
    mutationFn: () => api.createChannel(orgId, form),
    onSuccess: async (channel) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels(orgId) })
      close()
      navigate(`/w/${workspace.organization.slug}/c/${channel.id}`)
    },
  })
  const errors = fieldErrors(create.error)
  const preview = normalizeChannelName(form.name)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  const options: { value: ChannelVisibility; icon: typeof HashIcon; label: string; hint: string }[] = [
    { value: 'public', icon: HashIcon, label: t('chat.public'), hint: t('chat.publicHint') },
    { value: 'private', icon: LockIcon, label: t('chat.privateLabel'), hint: t('chat.privateHint') },
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('chat.createTitle')}</DialogTitle>
            <DialogDescription>{t('chat.createDescription')}</DialogDescription>
          </DialogHeader>
          {formError(create.error) && <Alert variant="error">{formError(create.error)}</Alert>}
          <Field
            label={t('chat.name')}
            error={errors.name}
            hint={preview && preview !== form.name.trim() ? `#${preview}` : t('chat.nameHint')}
          >
            <Input
              autoFocus
              icon={<HashIcon />}
              maxLength={60}
              placeholder={t('chat.namePlaceholder')}
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
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">{t('chat.visibility')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    'flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                    form.visibility === o.value ? 'border-primary bg-primary-soft/60' : 'hover:bg-accent/60',
                  )}
                >
                  <input
                    type="radio"
                    name="visibility"
                    className="sr-only"
                    checked={form.visibility === o.value}
                    onChange={() => setForm({ ...form, visibility: o.value })}
                  />
                  <o.icon className={cn('mt-0.5 size-4 shrink-0', form.visibility === o.value ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="grid gap-0.5">
                    <span className="text-[13px] font-medium">{o.label}</span>
                    <span className="text-xs text-muted-foreground">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {form.visibility === 'private' && canPickMembers && (
            <div className="grid gap-1.5">
              <p className="text-[13px] font-medium">{t('chat.initialMembers')}</p>
              <MemberPicker selected={form.memberIds} onChange={(memberIds) => setForm({ ...form, memberIds })} />
              {errors.memberIds && <p className="text-xs text-destructive">{errors.memberIds}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || !preview}>
              {t('chat.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
