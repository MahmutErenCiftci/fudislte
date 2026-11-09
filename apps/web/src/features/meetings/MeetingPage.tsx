import type { Meeting } from '@fudislte/api-client'
import {
  Avatar,
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CalendarDaysIcon,
  CheckIcon,
  ClockIcon,
  EllipsisIcon,
  LinkIcon,
  ListTodoIcon,
  PencilIcon,
  UsersIcon,
  VideoIcon,
  XCircleIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'

import { useT } from '../../i18n'
import { api, queryKeys } from '../../lib/api'
import { formatDateTime, formatLongDate, formatTimeRange } from '../../lib/format'
import { useWorkspace } from '../../shell/context'
import { ConfirmDialog } from '../chat/ChannelDialogs'
import { voiceCalls, voiceKey } from '../voice/target'
import { isInCall, useVoice } from '../voice/voice'
import { VoicePanel } from '../voice/VoicePanel'
import { CreateMeetingDialog } from './CreateMeetingDialog'
import { meetingPeople, PhaseBadge, useNow } from './meetings'
import { formatDuration, type MeetingPhase, meetingPhase } from './time'

/**
 * /w/:slug/m/:meetingId — one meeting (mockup "Yeni 06"): its time, people and agenda,
 * and the call, which opens 15 minutes before the start. Only the organizer and the
 * invitees reach it; anyone else gets "not found".
 */
export function MeetingPage() {
  const t = useT()
  const { meetingId = '' } = useParams()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const meeting = useQuery({ queryKey: queryKeys.meeting(orgId, meetingId), queryFn: () => api.meeting(orgId, meetingId) })
  const now = useNow()

  if (meeting.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }
  if (!meeting.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-[14px] text-muted-foreground">{t('meetings.notFound')}</p>
        <Button variant="outline" asChild>
          <Link to={`/w/${workspace.organization.slug}/meetings`}>{t('meetings.back')}</Link>
        </Button>
      </div>
    )
  }
  const m = meeting.data
  const phase = meetingPhase(m, now)
  return (
    <div className="flex flex-1 flex-col">
      <MeetingHeader meeting={m} phase={phase} />
      <VoicePanel kind="meeting" id={m.id} name={m.title} canModerate={m.isOrganizer} unavailable={unavailable(m, phase, t)} />
      <div className="grid content-start gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="overflow-hidden rounded-xl border bg-card">
          <header className="flex items-center gap-3 border-b px-5 py-3.5">
            <ListTodoIcon className="size-5 text-primary" />
            <h2 className="text-[15px] font-semibold">{t('meetings.agenda')}</h2>
          </header>
          {m.agenda ? (
            <p className="px-5 py-4 text-[14px] leading-6 whitespace-pre-wrap">{m.agenda}</p>
          ) : (
            <p className="px-5 py-4 text-[13px] text-muted-foreground">{t('meetings.noAgenda')}</p>
          )}
        </section>
        <People meeting={m} />
      </div>
    </div>
  )
}

/** Why nobody can join now, for the call panel; undefined while the meeting is open. */
function unavailable(m: Meeting, phase: MeetingPhase, t: ReturnType<typeof useT>): string | undefined {
  switch (phase) {
    case 'canceled':
      return t('meetings.canceledText')
    case 'scheduled':
      return t('meetings.opensAt', { time: formatDateTime(m.opensAt) })
    case 'ended':
      return t('meetings.endedText')
  }
  return undefined
}

function MeetingHeader({ meeting, phase }: { meeting: Meeting; phase: MeetingPhase }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<'edit' | 'cancel' | null>(null)
  const [copied, setCopied] = useState(false)
  const list = `/w/${workspace.organization.slug}/meetings`
  const cancel = useMutation({
    mutationFn: () => api.cancelMeeting(orgId, meeting.id),
    onSuccess: async (canceled) => {
      qc.setQueryData(queryKeys.meeting(orgId, meeting.id), canceled)
      setDialog(null)
      await qc.invalidateQueries({ queryKey: queryKeys.meetings(orgId) })
    },
  })
  const copyLink = () => {
    void navigator.clipboard?.writeText(window.location.href.split('?')[0] ?? '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const editable = meeting.isOrganizer && phase !== 'canceled'

  return (
    <header className="shrink-0 border-b px-6 pt-4 pb-4">
      <Link
        to={list}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('meetings.back')}
      </Link>
      <div className="flex items-start gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <VideoIcon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className={cn('truncate text-2xl font-bold tracking-tight', phase === 'canceled' && 'line-through decoration-2')}>
              {meeting.title}
            </h1>
            <PhaseBadge phase={phase} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CalendarDaysIcon className="size-4" />
              {formatLongDate(new Date(meeting.startsAt))}
            </span>
            <span className="flex items-center gap-1.5">
              <ClockIcon className="size-4" />
              {formatTimeRange(meeting.startsAt, meeting.endsAt)} · {formatDuration(meeting.durationMinutes)}
            </span>
            <span className="flex items-center gap-1.5">
              <UsersIcon className="size-4" />
              {t('meetings.participants', { count: meetingPeople(meeting).length })}
            </span>
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">
            {meeting.isOrganizer
              ? t('meetings.youOrganize')
              : t('meetings.organizedBy', { name: meeting.organizer?.displayName ?? t('meetings.formerMember') })}
          </p>
        </div>
        <Tooltip content={copied ? t('common.copied') : t('meetings.copyLink')} side="bottom">
          <Button variant="outline" size="icon" className="size-9" onClick={copyLink} aria-label={t('meetings.copyLink')}>
            {copied ? <CheckIcon /> : <LinkIcon />}
          </Button>
        </Tooltip>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-9" aria-label={t('meetings.options')}>
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDialog('edit')}>
                <PencilIcon />
                {t('meetings.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog('cancel')} className="text-destructive focus:text-destructive">
                <XCircleIcon />
                {t('meetings.cancel')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {editable && (
        <>
          <CreateMeetingDialog open={dialog === 'edit'} onOpenChange={(o) => setDialog(o ? 'edit' : null)} meeting={meeting} />
          <ConfirmDialog
            open={dialog === 'cancel'}
            title={t('meetings.cancelTitle', { title: meeting.title })}
            text={t('meetings.cancelText')}
            action={t('meetings.cancel')}
            pending={cancel.isPending}
            error={cancel.error}
            onConfirm={() => cancel.mutate()}
            onOpenChange={(o) => setDialog(o ? 'cancel' : null)}
          />
        </>
      )}
    </header>
  )
}

/** The organizer and the invitees, with who is in the call now. */
function People({ meeting }: { meeting: Meeting }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const voice = useVoice()
  const here = isInCall(voice, 'meeting', meeting.id)
  // Shares the call panel's query; live events keep it current.
  const state = useQuery({
    queryKey: voiceKey(orgId, 'meeting', meeting.id),
    queryFn: () => voiceCalls('meeting').state(orgId, meeting.id),
    enabled: !here,
  })
  const inCall = new Set(here ? voice.members.map((p) => p.id) : (state.data?.participants ?? []).map((p) => p.userId))
  const people = meetingPeople(meeting)

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-3 border-b px-5 py-3.5">
        <UsersIcon className="size-5 text-primary" />
        <h2 className="flex-1 text-[15px] font-semibold">{t('meetings.people')}</h2>
        <span className="text-xs text-muted-foreground">{people.length}</span>
      </header>
      {!meeting.organizer && <p className="px-5 pt-3 text-xs text-muted-foreground">{t('meetings.organizerLeft')}</p>}
      <ul className="divide-y">
        {people.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-5 py-2.5">
            <Avatar
              name={p.displayName}
              seed={p.id}
              size="md"
              dot={inCall.has(p.id) ? { className: 'bg-success', label: t('meetings.inCall') } : undefined}
            />
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{p.displayName}</span>
            {p.id === meeting.organizer?.id && <Badge variant="primary">{t('meetings.organizer')}</Badge>}
            {inCall.has(p.id) && <span className="text-xs text-emerald-700 dark:text-emerald-400">{t('meetings.inCall')}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
