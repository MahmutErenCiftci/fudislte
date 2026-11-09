import { describe, expect, it } from 'vitest'

import { setLanguage } from '../../i18n'
import { formatTimeRange } from '../../lib/format'
import { voicePath } from '../voice/target'
import { canJoin, durationChoices, formatDuration, fromLocalInputs, meetingPhase, nextHalfHour, toLocalInputs } from './time'

const minute = 60_000

describe('meeting phases', () => {
  // Starts at 10:00 for 45 minutes: open from 09:45 until 12:45.
  const start = Date.UTC(2026, 10, 3, 10, 0)
  const meeting = {
    canceledAt: null,
    opensAt: new Date(start - 15 * minute).toISOString(),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 45 * minute).toISOString(),
    closesAt: new Date(start + 165 * minute).toISOString(),
  }

  it('follows the join window the server enforces', () => {
    const at = (offset: number) => meetingPhase(meeting, start + offset * minute)
    expect(at(-16)).toBe('scheduled')
    expect(at(-15)).toBe('soon')
    expect(at(0)).toBe('live')
    expect(at(45)).toBe('overtime')
    expect(at(164)).toBe('overtime')
    expect(at(165)).toBe('ended')
    expect((['scheduled', 'soon', 'live', 'overtime', 'ended'] as const).map((p) => canJoin(p))).toEqual([false, true, true, true, false])
  })

  it('never lets anyone join a canceled meeting', () => {
    const phase = meetingPhase({ ...meeting, canceledAt: new Date(start).toISOString() }, start)
    expect(phase).toBe('canceled')
    expect(canJoin(phase)).toBe(false)
  })
})

describe('meeting times', () => {
  it('round-trips date and time inputs in local time', () => {
    const date = new Date(2026, 10, 3, 9, 5)
    expect(toLocalInputs(date)).toEqual({ date: '2026-11-03', time: '09:05' })
    expect(fromLocalInputs('2026-11-03', '09:05')?.getTime()).toBe(date.getTime())
    expect(fromLocalInputs('2026-11-03', '09:05:00')?.getTime()).toBe(date.getTime())
    expect(fromLocalInputs('', '09:05')).toBeNull()
    expect(fromLocalInputs('2026-02-31', '09:05')).toBeNull()
  })

  it('starts new meetings on the next half hour', () => {
    expect(toLocalInputs(nextHalfHour(new Date(2026, 10, 3, 9, 5, 30)))).toEqual({ date: '2026-11-03', time: '09:30' })
    expect(toLocalInputs(nextHalfHour(new Date(2026, 10, 3, 23, 40)))).toEqual({ date: '2026-11-04', time: '00:00' })
  })

  it('names durations in hours and minutes', () => {
    setLanguage('tr')
    expect(formatDuration(45)).toBe('45 dakika')
    expect(formatDuration(90)).toBe('1 saat 30 dakika')
    expect(formatDuration(480)).toBe('8 saat')
    setLanguage('en')
    expect(formatDuration(60)).toBe('1 hour')
    expect(formatDuration(135)).toBe('2 hours 15 minutes')
    expect(durationChoices.every((m) => m >= 15 && m <= 480)).toBe(true)
  })

  it('writes time ranges in the current language', () => {
    setLanguage('tr')
    const start = new Date(2026, 10, 3, 10, 30).toISOString()
    const end = new Date(2026, 10, 3, 11, 15).toISOString()
    expect(formatTimeRange(start, end)).toBe('10:30 – 11:15')
  })
})

describe('voicePath', () => {
  it('leads the dock to the room or the meeting', () => {
    expect(voicePath({ kind: 'room', id: 'r1', slug: 'acme' })).toBe('/w/acme/r/r1')
    expect(voicePath({ kind: 'meeting', id: 'm1', slug: 'acme' })).toBe('/w/acme/m/m1')
  })
})
