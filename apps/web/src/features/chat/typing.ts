import type { Person } from '@fudislte/api-client'
import { useSyncExternalStore } from 'react'

// Who is typing where, from live "typing" events. Nothing is stored on the server; an
// entry disappears after a few seconds without a refresh, or when that person's message
// arrives.

const TYPING_TTL_MS = 6_000

type Key = string
const typing = new Map<Key, Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>>()
const snapshots = new Map<Key, string[]>()
const listeners = new Set<() => void>()
const empty: string[] = []

const keyOf = (channelId: string, parentId?: string | null) => `${channelId}:${parentId ?? ''}`

function changed(key: Key) {
  const people = typing.get(key)
  if (people?.size) {
    snapshots.set(key, [...people.values()].map((e) => e.name))
  } else {
    // Nobody types here any more: forget the place, so the maps do not grow all session.
    typing.delete(key)
    snapshots.delete(key)
  }
  for (const l of listeners) l()
}

export function noteTyping(channelId: string, parentId: string | null, user: Person) {
  const key = keyOf(channelId, parentId)
  const people = typing.get(key) ?? new Map()
  typing.set(key, people)
  clearTimeout(people.get(user.id)?.timer)
  people.set(user.id, { name: user.displayName, timer: setTimeout(() => stopTyping(channelId, parentId, user.id), TYPING_TTL_MS) })
  changed(key)
}

export function stopTyping(channelId: string, parentId: string | null | undefined, userId: string) {
  const key = keyOf(channelId, parentId)
  const people = typing.get(key)
  const entry = people?.get(userId)
  if (!people || !entry) return
  clearTimeout(entry.timer)
  people.delete(userId)
  changed(key)
}

/** Names of the people typing in a channel, or in one of its threads. */
export function useTyping(channelId: string, parentId?: string): string[] {
  const key = keyOf(channelId, parentId)
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshots.get(key) ?? empty,
  )
}
