import type { Task, WorkflowStatus } from '@fudislte/api-client'
import { describe, expect, it } from 'vitest'

import { addMonths, dateKey, monthGrid, tasksByDay } from './calendar'
import { activeFilters, columns, compareForList, emptyFilter, filterTasks, isOverdue } from './filters'
import { byRank, isValidRank, rankAt, rankBetween } from './rank'

describe('task ranks', () => {
  // The reference cases the API's Go implementation is tested with too.
  it('matches the server', () => {
    const cases: [string | null, string | null, string][] = [
      [null, null, 'a0'],
      [null, 'a0', 'Zz'],
      ['a0', null, 'a1'],
      ['a0', 'a1', 'a0V'],
      ['a0V', 'a1', 'a0l'],
      ['Zz', 'a0', 'ZzV'],
      [null, 'Y00', 'Xzzz'],
      ['bzz', null, 'c000'],
      ['a0', 'a0V', 'a0G'],
      ['b125', 'b129', 'b127'],
      ['a0', 'a1V', 'a1'],
    ]
    for (const [a, b, want] of cases) expect(rankBetween(a, b)).toBe(want)
    expect(() => rankBetween('a1', 'a0')).toThrow()
    expect(isValidRank('a00')).toBe(false)
    expect(isValidRank('a0V')).toBe(true)
  })

  it('places a card between its new neighbours', () => {
    const column = ['a0', 'a1', 'a2']
    expect(rankAt(column, 0) < 'a0').toBe(true)
    const middle = rankAt(column, 1)
    expect(middle > 'a0' && middle < 'a1').toBe(true)
    expect(rankAt(column, 3) > 'a2').toBe(true)
    expect(rankAt([], 0)).toBe('a0')
  })

  it('skips equal neighbours left by simultaneous moves', () => {
    const r = rankAt(['a0', 'a1', 'a1', 'a2'], 2)
    expect(r > 'a1' && r < 'a2').toBe(true)
  })

  it('keeps many random inserts in order', () => {
    let column: string[] = []
    for (let i = 0; i < 500; i++) {
      const at = Math.floor(Math.random() * (column.length + 1))
      column = [...column.slice(0, at), rankAt(column, at), ...column.slice(at)]
    }
    expect([...column].sort()).toEqual(column)
    expect(new Set(column).size).toBe(column.length)
  })
})

const status = (id: string, category: WorkflowStatus['category'], position: number): WorkflowStatus => ({
  id,
  name: id,
  category,
  color: 'slate',
  position,
})

function task(n: number, over: Partial<Task> = {}): Task {
  return {
    id: `t${n}`,
    project: { id: 'p', key: 'ENG', name: 'Engineering', color: 'blue' },
    number: n,
    key: `ENG-${n}`,
    title: `Görev ${n}`,
    status: { id: 'todo', name: 'Yapılacak', category: 'todo', color: 'slate' },
    priority: 'none',
    dueOn: null,
    sprintId: null,
    rank: `a${n}`,
    assignees: [],
    labels: [],
    checklist: { done: 0, total: 0 },
    commentCount: 0,
    createdBy: null,
    createdAt: '2026-10-30T10:00:00Z',
    updatedAt: '2026-10-30T10:00:00Z',
    completedAt: null,
    ...over,
  }
}

describe('task filters', () => {
  const me = { id: 'me', displayName: 'Ben' }
  const tasks = [
    task(1, { title: 'Ödeme ekranı', assignees: [me], labels: [{ id: 'l1', name: 'Ön yüz', color: 'blue' }], priority: 'high' }),
    task(2, { title: 'İzleme', sprintId: 's1', priority: 'low' }),
    task(3, { title: 'Arama', assignees: [{ id: 'other', displayName: 'Diğer' }], sprintId: 's1' }),
  ]

  it('combines scope, search, labels, people, sprint and priority', () => {
    const ids = (f: Partial<typeof emptyFilter>) => filterTasks(tasks, { ...emptyFilter, ...f }, me.id).map((t) => t.number)
    expect(ids({})).toEqual([1, 2, 3])
    expect(ids({ scope: 'mine' })).toEqual([1])
    expect(ids({ scope: 'unassigned' })).toEqual([2])
    expect(ids({ query: 'ÖDEME' })).toEqual([1])
    expect(ids({ query: 'izleme' })).toEqual([2]) // Turkish İ folds to i
    expect(ids({ query: 'eng-3' })).toEqual([3])
    expect(ids({ labelIds: ['l1'] })).toEqual([1])
    expect(ids({ assigneeIds: ['other', 'me'] })).toEqual([1, 3])
    expect(ids({ sprint: 'backlog' })).toEqual([1])
    expect(ids({ sprint: 's1', priorities: ['low'] })).toEqual([2])
    expect(activeFilters({ ...emptyFilter, query: ' ', sprint: 's1', scope: 'mine' })).toBe(2)
  })

  it('builds rank-ordered columns and orders lists', () => {
    const statuses = [status('todo', 'todo', 0), status('done', 'done', 1)]
    const done = { id: 'done', name: 'Bitti', category: 'done' as const, color: 'green' as const }
    const cols = columns(statuses, [task(3, { rank: 'a0' }), task(1, { rank: 'a5' }), task(2, { status: done })])
    expect(cols.map((c) => c.tasks.map((t) => t.number))).toEqual([[3, 1], [2]])
    const sorted = [task(1, { status: done }), task(2, { dueOn: '2026-11-05' }), task(3), task(4, { dueOn: '2026-11-01' })].sort(
      compareForList,
    )
    expect(sorted.map((t) => t.number)).toEqual([4, 2, 3, 1])
    expect(isOverdue(task(5, { dueOn: '2026-10-01' }), '2026-10-30')).toBe(true)
    expect(isOverdue(task(5, { dueOn: '2026-10-01', status: done }), '2026-10-30')).toBe(false)
  })
})

describe('task calendar', () => {
  it('shows six weeks starting on the chosen weekday', () => {
    const november = monthGrid({ year: 2026, month: 10 }, 1)
    expect(november).toHaveLength(42)
    expect(dateKey(november[0]!)).toBe('2026-10-26') // 1 November 2026 is a Sunday
    expect(november[0]!.getDay()).toBe(1)
    expect(dateKey(monthGrid({ year: 2026, month: 10 }, 0)[0]!)).toBe('2026-11-01')
    expect(addMonths({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 })
  })

  it('groups tasks by due date', () => {
    const days = tasksByDay([task(1, { dueOn: '2026-11-03' }), task(2), task(3, { dueOn: '2026-11-03' })])
    expect([...days.keys()]).toEqual(['2026-11-03'])
    expect(days.get('2026-11-03')?.map((t) => t.number)).toEqual([1, 3])
    expect(byRank({ rank: 'a1', id: 'x' }, { rank: 'a1', id: 'y' })).toBe(-1)
  })
})
