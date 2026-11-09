import type { Meeting } from '@fudislte/api-client'

import { t } from '../../i18n'

/**
 * Where a meeting stands: people may join while it is "soon" (the 15 minutes before the
 * start), "live" or "overtime" (up to 2 hours after the scheduled end) — the window the
 * server enforces with opensAt and closesAt.
 */
export type MeetingPhase = 'canceled' | 'scheduled' | 'soon' | 'live' | 'overtime' | 'ended'

export function meetingPhase(m: Pick<Meeting, 'canceledAt' | 'opensAt' | 'startsAt' | 'endsAt' | 'closesAt'>, now: number): MeetingPhase {
  if (m.canceledAt) return 'canceled'
  const at = (iso: string) => new Date(iso).getTime()
  if (now < at(m.opensAt)) return 'scheduled'
  if (now < at(m.startsAt)) return 'soon'
  if (now < at(m.endsAt)) return 'live'
  if (now < at(m.closesAt)) return 'overtime'
  return 'ended'
}

export function canJoin(phase: MeetingPhase): boolean {
  return phase === 'soon' || phase === 'live' || phase === 'overtime'
}

/** Lengths offered in the meeting dialog, in minutes; the server accepts 15 to 480. */
export const durationChoices = [15, 30, 45, 60, 90, 120, 180, 240, 480]

/** "45 dakika", "1 saat 30 dakika", "2 saat". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return t('rooms.minutes', { count: rest })
  if (rest === 0) return t('rooms.hours', { count: hours })
  return `${t('rooms.hours', { count: hours })} ${t('rooms.minutes', { count: rest })}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The values of a date and a time input showing date in local time. */
export function toLocalInputs(date: Date): { date: string; time: string } {
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

/** The moment that a date and a time input name in local time; null when incomplete. */
export function fromLocalInputs(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const tm = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time)
  if (!d || !tm) return null
  const out = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(tm[1]), Number(tm[2]))
  return Number.isNaN(out.getTime()) || out.getDate() !== Number(d[3]) ? null : out
}

/** Where a new meeting starts by default: the next full or half hour. */
export function nextHalfHour(now: Date): Date {
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60)
  return d
}

/** The browser's IANA time zone, which emails use to write the meeting's time. */
export function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}
