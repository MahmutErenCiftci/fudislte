import type { BoardElement } from '@fudislte/api-client'
import { describe, expect, it } from 'vitest'

import { batches, byIndex, mergeElements, pendingChanges, personColor, remoteWins } from './sync'

const el = (id: string, version: number, versionNonce: number, extra: Partial<BoardElement> = {}): BoardElement => ({
  id,
  type: 'rectangle',
  version,
  versionNonce,
  isDeleted: false,
  index: 'a0',
  ...extra,
})

describe('whiteboard merge rules (mirroring the server)', () => {
  it('takes the higher version, and on a tie the lower nonce', () => {
    expect(remoteWins(undefined, el('a', 1, 5))).toBe(true)
    expect(remoteWins(el('a', 2, 5), el('a', 3, 9))).toBe(true)
    expect(remoteWins(el('a', 3, 5), el('a', 2, 1))).toBe(false)
    expect(remoteWins(el('a', 3, 5), el('a', 3, 4))).toBe(true)
    expect(remoteWins(el('a', 3, 5), el('a', 3, 6))).toBe(false)
    expect(remoteWins(el('a', 3, 5), el('a', 3, 5))).toBe(false)
  })

  it('converges whatever order copies arrive in', () => {
    const copies = [el('a', 2, 30), el('a', 2, 10), el('a', 1, 1), el('a', 2, 20)]
    const orders = [copies, [...copies].reverse(), [copies[2]!, copies[0]!, copies[3]!, copies[1]!]]
    for (const order of orders) {
      let scene: BoardElement[] = []
      for (const c of order) scene = mergeElements(scene, [c]).elements
      expect(scene).toEqual([el('a', 2, 10)])
    }
  })

  it('keeps what is being edited and orders the scene by index', () => {
    const local = [el('a', 4, 1, { index: 'a1' }), el('b', 1, 1, { index: 'a2' })]
    const { elements, taken } = mergeElements(local, [el('a', 9, 1, { index: 'a3' }), el('c', 1, 1, { index: 'a0' })], new Set(['a']))
    expect(elements.map((e) => e.id)).toEqual(['c', 'a', 'b'])
    expect(elements.find((e) => e.id === 'a')?.version).toBe(4)
    expect(taken.map((e) => e.id)).toEqual(['c'])
    expect([el('b', 1, 1, { index: 'a1' }), el('a', 1, 1, { index: 'a1' })].sort(byIndex).map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('whiteboard sending', () => {
  it('sends changed elements of supported types only', () => {
    const synced = new Map([
      ['a', 2],
      ['b', 1],
    ])
    const scene = [el('a', 2, 1), el('b', 2, 1), el('c', 1, 1), el('img', 1, 1, { type: 'image' })]
    expect(pendingChanges(scene, synced).map((e) => e.id)).toEqual(['b', 'c'])
  })

  it('splits large changes into requests', () => {
    const many = Array.from({ length: 450 }, (_, i) => el(`e${i}`, 1, 1))
    expect(batches(many).map((b) => b.length)).toEqual([200, 200, 50])
    const big = Array.from({ length: 3 }, (_, i) => el(`f${i}`, 1, 1, { points: 'x'.repeat(800_000) }))
    expect(batches(big).map((b) => b.length)).toEqual([1, 1, 1])
  })

  it('gives each person a stable colour', () => {
    expect(personColor('user-1')).toEqual(personColor('user-1'))
    expect(personColor('user-1').stroke).toMatch(/^hsl\(/)
  })
})
