import type { Task } from '@fudislte/api-client'

import { todayKey } from './filters'

/** A calendar month: year and month (0–11). */
export interface Month {
  year: number
  month: number
}

export function monthOf(date: Date): Month {
  return { year: date.getFullYear(), month: date.getMonth() }
}

export function addMonths(m: Month, delta: number): Month {
  const d = new Date(m.year, m.month + delta, 1)
  return monthOf(d)
}

/**
 * The 42 days (six weeks) a month grid shows, starting on weekStart (1 Monday, 0
 * Sunday), including the end of the previous month and the start of the next.
 */
export function monthGrid(m: Month, weekStart: 0 | 1): Date[] {
  const first = new Date(m.year, m.month, 1)
  const offset = (first.getDay() - weekStart + 7) % 7
  return Array.from({ length: 42 }, (_, i) => new Date(m.year, m.month, 1 - offset + i))
}

/** A date as YYYY-MM-DD in local time, the format of due dates. */
export function dateKey(d: Date): string {
  return todayKey(d)
}

/** Tasks by due date (YYYY-MM-DD); tasks without one are left out. */
export function tasksByDay(tasks: readonly Task[]): Map<string, Task[]> {
  const out = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.dueOn) continue
    const list = out.get(t.dueOn)
    if (list) list.push(t)
    else out.set(t.dueOn, [t])
  }
  return out
}
