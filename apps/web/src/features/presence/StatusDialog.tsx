import type { StatusKind } from '@fudislte/api-client'
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
  Label,
  NativeSelect,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'

import { useT } from '../../i18n'
import { api, fieldErrors, formError, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { liveStatus, statusKinds } from './presence'

const durations = [
  { value: '30', label: 'status.for30m', minutes: 30 },
  { value: '60', label: 'status.for1h', minutes: 60 },
  { value: '240', label: 'status.for4h', minutes: 240 },
  { value: 'today', label: 'status.forToday', minutes: 0 },
  { value: 'never', label: 'status.forever', minutes: 0 },
] as const

function expiresAt(choice: string): string | null {
  if (choice === 'never') return null
  const end = new Date()
  if (choice === 'today') end.setHours(23, 59, 0, 0)
  else end.setMinutes(end.getMinutes() + Number(choice))
  return end.toISOString()
}

/** Sets what the signed-in person is doing, as shown in the people list. */
export function StatusDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const { me } = useWorkspace()
  const qc = useQueryClient()
  const current = liveStatus(me.user.status)
  const [kind, setKind] = useState<StatusKind>(current?.kind ?? 'meeting')
  const [text, setText] = useState(current?.text ?? '')
  const [duration, setDuration] = useState('60')
  const [mute, setMute] = useState(current?.mute ?? true)

  const done = async () => {
    await qc.invalidateQueries({ queryKey: queryKeys.me })
    onOpenChange(false)
  }
  const save = useMutation({
    mutationFn: () => api.setStatus({ kind, text, expiresAt: expiresAt(duration), mute }),
    onSuccess: done,
  })
  const clear = useMutation({ mutationFn: api.clearStatus, onSuccess: done })
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
        if (!o) {
          save.reset()
          clear.reset()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('status.title')}</DialogTitle>
            <DialogDescription>{t('status.description')}</DialogDescription>
          </DialogHeader>
          {(formError(save.error) || formError(clear.error)) && (
            <Alert variant="error">{formError(save.error) ?? formError(clear.error)}</Alert>
          )}
          <div role="radiogroup" aria-label={t('status.title')} className="grid grid-cols-2 gap-2">
            {statusKinds.map((k) => (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={kind === k.kind}
                onClick={() => {
                  setKind(k.kind)
                  setMute(k.mute)
                }}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                  kind === k.kind ? 'border-primary bg-primary-soft/60' : 'hover:bg-accent/60',
                )}
              >
                <span className={cn('size-2.5 shrink-0 rounded-full', k.dot)} />
                <span className="text-base leading-none">{k.emoji}</span>
                {t(k.label)}
              </button>
            ))}
          </div>
          <Field label={kind === 'custom' ? t('status.text') : t('status.note')} error={errors.text}>
            <Input
              maxLength={100}
              placeholder={kind === 'custom' ? t('status.textPlaceholder') : t('status.notePlaceholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <Field label={t('status.clearAfter')} error={errors.expiresAt}>
            <NativeSelect value={duration} onChange={(e) => setDuration(e.target.value)}>
              {durations.map((d) => (
                <option key={d.value} value={d.value}>
                  {t(d.label)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex items-start gap-2.5">
            <Checkbox id="status-mute" className="mt-0.5" checked={mute} onCheckedChange={(v) => setMute(v === true)} />
            <Label htmlFor="status-mute" className="grid gap-0.5 leading-snug font-normal">
              <span className="font-medium">{t('status.mute')}</span>
              <span className="text-xs text-muted-foreground">{t('status.muteHint')}</span>
            </Label>
          </div>
          <DialogFooter className="sm:justify-between">
            <div>
              {current && (
                <Button variant="ghost" onClick={() => clear.mutate()} disabled={clear.isPending}>
                  {t('status.clear')}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={save.isPending || (kind === 'custom' && !text.trim())}>
                {t('status.save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
