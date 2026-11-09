import type { Meeting, MeetingRange, Person } from '@fudislte/api-client'
import { Avatar, Badge, type BadgeVariant, Button, cn } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { VideoIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { type MessageKey, useT } from '../../i18n'
import { api, queryKeys } from '../../lib/api'
import { formatDay, formatTime } from '../../lib/format'
import { useWorkspace } from '../../shell/context'
import { type VoiceTarget, voicePath } from '../voice/target'
import { isInCall, joinVoice, useVoice } from '../voice/voice'
import type { MeetingPhase } from './time'

/** The caller's meetings, kept current by meeting.updated events. */
export function useMeetings(range: MeetingRange) {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  return useQuery({ queryKey: queryKeys.meetingList(orgId, range), queryFn: () => api.meetings(orgId, range) })
}

/** The current time, refreshed every 30 seconds, so join buttons appear when a meeting opens. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function useMeetingTarget(meeting: Meeting): VoiceTarget {
  const { workspace } = useWorkspace()
  return {
    kind: 'meeting',
    id: meeting.id,
    name: meeting.title,
    orgId: workspace.organization.id,
    slug: workspace.organization.slug,
  }
}

const phaseBadges: Partial<Record<MeetingPhase, { label: MessageKey; variant: BadgeVariant }>> = {
  canceled: { label: 'meetings.phase.canceled', variant: 'destructive' },
  soon: { label: 'meetings.phase.soon', variant: 'amber' },
  live: { label: 'meetings.phase.live', variant: 'success' },
  overtime: { label: 'meetings.phase.live', variant: 'success' },
}

/** "İptal edildi", "Birazdan", "Şimdi"; nothing for meetings far ahead or over. */
export function PhaseBadge({ phase, className }: { phase: MeetingPhase; className?: string }) {
  const t = useT()
  const badge = phaseBadges[phase]
  if (!badge) return null
  return (
    <Badge variant={badge.variant} className={className}>
      {phase === 'live' || phase === 'overtime' ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {t(badge.label)}
    </Badge>
  )
}

/** Overlapping avatars, then "+N" for the rest. */
export function AvatarStack({ people, max = 4, className }: { people: Person[]; max?: number; className?: string }) {
  const shown = people.slice(0, max)
  return (
    <span className={cn('flex items-center -space-x-1.5', className)}>
      {shown.map((p) => (
        <Avatar key={p.id} name={p.displayName} seed={p.id} size="sm" className="ring-2 ring-card" />
      ))}
      {people.length > max && (
        <span className="relative flex size-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground ring-2 ring-card">
          +{people.length - max}
        </span>
      )}
    </span>
  )
}

/** Everyone in a meeting: the organizer first, then the invitees. */
export function meetingPeople(meeting: Meeting): Person[] {
  return meeting.organizer ? [meeting.organizer, ...meeting.invitees] : meeting.invitees
}

/** Joins the meeting's call and opens its page. */
export function JoinMeetingButton({ meeting, className, variant = 'default' }: { meeting: Meeting; className?: string; variant?: 'default' | 'outline' }) {
  const t = useT()
  const navigate = useNavigate()
  const voice = useVoice()
  const target = useMeetingTarget(meeting)
  const join = () => {
    if (!isInCall(voice, 'meeting', meeting.id)) void joinVoice(target)
    navigate(voicePath(target))
  }
  return (
    <Button size="sm" variant={variant} className={className} onClick={join}>
      <VideoIcon />
      {t('meetings.join')}
    </Button>
  )
}

/** One upcoming meeting in a list (home page): times, title, day and people, and "Katıl" while it is open. */
export function MeetingRow({ meeting, joinable }: { meeting: Meeting; joinable: boolean }) {
  const { workspace } = useWorkspace()
  return (
    <li className="flex items-center gap-4 px-5 py-3">
      <div className="w-14 shrink-0 tabular-nums">
        <p className="text-[14px] font-semibold">{formatTime(meeting.startsAt)}</p>
        <p className="text-xs text-muted-foreground">{formatTime(meeting.endsAt)}</p>
      </div>
      <div className="min-w-0 flex-1">
        <Link
          to={`/w/${workspace.organization.slug}/m/${meeting.id}`}
          className="block truncate text-[14px] font-semibold outline-none hover:underline focus-visible:underline"
        >
          {meeting.title}
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <AvatarStack people={meetingPeople(meeting)} max={3} />
          <span className="truncate text-xs text-muted-foreground">{formatDay(meeting.startsAt)}</span>
        </div>
      </div>
      {joinable && <JoinMeetingButton meeting={meeting} variant="outline" />}
    </li>
  )
}
