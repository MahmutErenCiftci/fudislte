import type { Meeting, MeetingInput } from '@fudislte/api-client'
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
  NativeSelect,
  Textarea,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'

import { useT } from '../../i18n'
import { api, fieldErrors, formError, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { MemberPicker } from '../chat/MemberPicker'
import { durationChoices, formatDuration, fromLocalInputs, localTimeZone, nextHalfHour, toLocalInputs } from './time'

interface Form {
  title: string
  date: string
  time: string
  duration: number
  inviteeIds: string[]
  agenda: string
}

function formFor(meeting: Meeting | undefined): Form {
  if (!meeting) {
    return { title: '', ...toLocalInputs(nextHalfHour(new Date())), duration: 30, inviteeIds: [], agenda: '' }
  }
  return {
    title: meeting.title,
    ...toLocalInputs(new Date(meeting.startsAt)),
    duration: meeting.durationMinutes,
    inviteeIds: meeting.invitees.map((p) => p.id),
    agenda: meeting.agenda,
  }
}

/** Schedules a meeting, or edits one when `meeting` is given (its organizer). */
export function CreateMeetingDialog({
  open,
  onOpenChange,
  meeting,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meeting?: Meeting
}) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState(() => formFor(meeting))
  const [badTime, setBadTime] = useState(false)
  // Each opening starts from the meeting as it is now (or an empty form).
  const [shown, setShown] = useState(open)
  if (open !== shown) {
    setShown(open)
    if (open) {
      setForm(formFor(meeting))
      setBadTime(false)
    }
  }
  const canPickPeople = can(workspace, 'members.view')
  const durations = durationChoices.includes(form.duration) ? durationChoices : [...durationChoices, form.duration].sort((a, b) => a - b)

  const save = useMutation({
    mutationFn: (input: MeetingInput) => (meeting ? api.updateMeeting(orgId, meeting.id, input) : api.createMeeting(orgId, input)),
    onSuccess: async (saved) => {
      qc.setQueryData(queryKeys.meeting(orgId, saved.id), saved)
      await qc.invalidateQueries({ queryKey: queryKeys.meetings(orgId) })
      close()
      if (!meeting) navigate(`/w/${workspace.organization.slug}/m/${saved.id}`)
    },
  })
  const close = () => {
    onOpenChange(false)
    save.reset()
  }
  const errors = fieldErrors(save.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const startsAt = fromLocalInputs(form.date, form.time)
    setBadTime(!startsAt)
    if (!startsAt) return
    save.mutate({
      title: form.title,
      agenda: form.agenda,
      startsAt: startsAt.toISOString(),
      durationMinutes: form.duration,
      timeZone: localTimeZone(),
      // Without the member list the invitations stay as they are.
      ...(canPickPeople && { inviteeIds: form.inviteeIds }),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{meeting ? t('meetings.editTitle') : t('meetings.createTitle')}</DialogTitle>
            <DialogDescription>{meeting ? t('meetings.editDescription') : t('meetings.createDescription')}</DialogDescription>
          </DialogHeader>
          {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
          {errors.timeZone && <Alert variant="error">{errors.timeZone}</Alert>}
          <Field label={t('meetings.titleLabel')} error={errors.title}>
            <Input
              autoFocus
              maxLength={120}
              placeholder={t('meetings.titlePlaceholder')}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('meetings.date')} error={badTime ? t('meetings.timeInvalid') : errors.startsAt}>
              <Input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </Field>
            <Field label={t('meetings.time')}>
              <Input type="time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
            </Field>
            <Field label={t('meetings.duration')} error={errors.durationMinutes}>
              <NativeSelect value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })}>
                {durations.map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-1.5">
            <p className="text-[13px] font-medium">{t('meetings.invitees')}</p>
            {canPickPeople ? (
              <>
                <p className="text-xs text-muted-foreground">{t('meetings.inviteesHint')}</p>
                <MemberPicker selected={form.inviteeIds} onChange={(inviteeIds) => setForm({ ...form, inviteeIds })} />
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{t('meetings.inviteesNoPermission')}</p>
                {meeting && meeting.invitees.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {meeting.invitees.map((p) => (
                      <li key={p.id} className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
                        <Avatar name={p.displayName} seed={p.id} size="xs" />
                        {p.displayName}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {errors.inviteeIds && <p className="text-xs text-destructive">{errors.inviteeIds}</p>}
          </div>
          <Field label={t('meetings.agenda')} error={errors.agenda}>
            <Textarea
              rows={4}
              maxLength={2000}
              placeholder={t('meetings.agendaPlaceholder')}
              value={form.agenda}
              onChange={(e) => setForm({ ...form, agenda: e.target.value })}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending || !form.title.trim()}>
              {meeting ? t('common.save') : t('meetings.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
