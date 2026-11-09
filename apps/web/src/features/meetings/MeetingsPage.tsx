import type { Meeting, MeetingRange } from '@fudislte/api-client'
import { Alert, Button, cn, Spinner } from '@fudislte/ui'
import { CalendarClockIcon, PlusIcon, VideoIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { errorMessage } from '../../lib/api'
import { formatCalendarTile, formatLongDate, formatTimeRange } from '../../lib/format'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { PageHeader } from '../../shell/PageHeader'
import { CreateMeetingDialog } from './CreateMeetingDialog'
import { AvatarStack, JoinMeetingButton, meetingPeople, PhaseBadge, useMeetings, useNow } from './meetings'
import { canJoin, meetingPhase } from './time'

/** /w/:slug/meetings — the meetings the caller organizes or is invited to (mockup "Yeni 06"). */
export function MeetingsPage() {
  const t = useT()
  const { workspace } = useWorkspace()
  const [range, setRange] = useState<MeetingRange>('upcoming')
  const meetings = useMeetings(range)
  const [creating, setCreating] = useState(false)
  const canCreate = can(workspace, 'meetings.create')
  const now = useNow()

  return (
    <>
      <PageHeader
        icon={VideoIcon}
        title={t('meetings.title')}
        description={t('meetings.description')}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              {t('meetings.create')}
            </Button>
          )
        }
      >
        <nav className="mt-5 flex gap-1 border-b">
          {(['upcoming', 'past'] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-current={range === r ? 'page' : undefined}
              onClick={() => setRange(r)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:text-foreground',
                range === r ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {r === 'upcoming' ? t('meetings.upcoming') : t('meetings.past')}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="px-6 py-6">
        {meetings.isPending && (
          <div className="flex justify-center p-10">
            <Spinner label={t('common.loading')} />
          </div>
        )}
        {meetings.error && <Alert variant="error">{errorMessage(meetings.error)}</Alert>}
        {meetings.data?.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-12 text-center">
            <CalendarClockIcon className="size-8 text-muted-foreground" />
            <p className="text-[15px] font-medium">{range === 'upcoming' ? t('meetings.empty') : t('meetings.emptyPast')}</p>
            {range === 'upcoming' && <p className="max-w-md text-[13px] text-muted-foreground">{t('meetings.emptyHint')}</p>}
            {range === 'upcoming' && canCreate && (
              <Button className="mt-2" onClick={() => setCreating(true)}>
                <PlusIcon />
                {t('meetings.create')}
              </Button>
            )}
          </div>
        )}
        {meetings.data && meetings.data.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
            {meetings.data.map((m) => (
              <li key={m.id}>
                <MeetingCard meeting={m} now={now} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {canCreate && <CreateMeetingDialog open={creating} onOpenChange={setCreating} />}
    </>
  )
}

function MeetingCard({ meeting, now }: { meeting: Meeting; now: number }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const phase = meetingPhase(meeting, now)
  const tile = formatCalendarTile(meeting.startsAt)
  return (
    <article
      className={cn(
        'relative flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/30 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring/50',
        phase === 'canceled' && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-12 shrink-0 flex-col items-center justify-center rounded-xl bg-primary-soft text-primary-soft-foreground">
          <span className="text-[10px] leading-3 font-semibold uppercase">{tile.month}</span>
          <span className="text-lg leading-5 font-bold">{tile.day}</span>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={cn('truncate text-[15px] font-semibold', phase === 'canceled' && 'line-through')}>
            {/* The whole card opens the meeting; the join button stays on top of the link. */}
            <Link to={`/w/${workspace.organization.slug}/m/${meeting.id}`} className="outline-none after:absolute after:inset-0">
              {meeting.title}
            </Link>
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {formatLongDate(new Date(meeting.startsAt))} · {formatTimeRange(meeting.startsAt, meeting.endsAt)}
          </p>
        </div>
        <PhaseBadge phase={phase} />
      </div>
      <p className="line-clamp-2 min-h-[2lh] text-[13px] whitespace-pre-line text-muted-foreground">{meeting.agenda}</p>
      <div className="mt-auto flex items-center gap-3">
        <AvatarStack people={meetingPeople(meeting)} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {meeting.isOrganizer
            ? t('meetings.youOrganize')
            : t('meetings.organizedBy', { name: meeting.organizer?.displayName ?? t('meetings.formerMember') })}
        </span>
        {canJoin(phase) && <JoinMeetingButton meeting={meeting} className="relative z-10" />}
      </div>
    </article>
  )
}
