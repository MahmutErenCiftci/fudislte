import type { LiveEvents } from '@fudislte/api-client'

// Board events from the app's single event stream (useLiveEvents) to the open board.
// "resync" follows a reconnect: events may have been missed, so the board merges the
// stored scene again.

export type BoardEvent =
  | { type: 'board.elements'; data: LiveEvents['board.elements'] }
  | { type: 'board.cursor'; data: LiveEvents['board.cursor'] }
  | { type: 'board.viewers'; data: LiveEvents['board.viewers'] }
  | { type: 'board.updated'; data: LiveEvents['board.updated'] }
  | { type: 'board.deleted'; data: LiveEvents['board.deleted'] }
  | { type: 'resync' }

const listeners = new Set<(e: BoardEvent) => void>()

export function emitBoardEvent(e: BoardEvent) {
  for (const l of listeners) l(e)
}

export function onBoardEvent(listener: (e: BoardEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
