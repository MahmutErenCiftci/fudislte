import type { BoardElement } from '@fudislte/api-client'

// Whiteboard sync rules, shared by the canvas and its tests. They mirror the API
// (services/api/internal/boards/elements.go), which is Excalidraw's own rule: the copy
// with the higher version wins, and on equal versions the lower versionNonce.

/** The element types the server stores; images and embeds are not synced. */
export const SYNCED_TYPES: ReadonlySet<string> = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'frame'])

type Versioned = Pick<BoardElement, 'id' | 'version' | 'versionNonce'>

/** Whether a remote copy replaces the local one. */
export function remoteWins(local: Versioned | undefined, remote: Versioned): boolean {
  if (!local) return true
  return remote.version > local.version || (remote.version === local.version && remote.versionNonce < local.versionNonce)
}

/** Excalidraw's z-order: by fractional index, ties by ID. */
export function byIndex(a: Pick<BoardElement, 'id' | 'index'>, b: Pick<BoardElement, 'id' | 'index'>): number {
  const ai = a.index ?? ''
  const bi = b.index ?? ''
  if (ai !== bi) return ai < bi ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Merges remote elements into the local scene. Elements in keep (the ones being drawn,
 * resized or typed into right now) stay local; the next save sends them with a higher
 * version. Returns the scene in z-order and the remote elements that were taken.
 */
export function mergeElements<T extends BoardElement>(
  local: readonly T[],
  remote: readonly T[],
  keep: ReadonlySet<string> = new Set(),
): { elements: T[]; taken: T[] } {
  const byId = new Map(local.map((e) => [e.id, e]))
  const taken: T[] = []
  for (const r of remote) {
    if (keep.has(r.id) || !remoteWins(byId.get(r.id), r)) continue
    byId.set(r.id, r)
    taken.push(r)
  }
  return { elements: [...byId.values()].sort(byIndex), taken }
}

/** The elements whose version changed since it was last sent or received. */
export function pendingChanges<T extends BoardElement>(elements: readonly T[], synced: ReadonlyMap<string, number>): T[] {
  return elements.filter((e) => SYNCED_TYPES.has(e.type) && synced.get(e.id) !== e.version)
}

/** Splits changes into requests of at most maxCount elements and roughly maxBytes of JSON. */
export function batches<T>(items: readonly T[], maxCount = 200, maxBytes = 1_500_000): T[][] {
  const out: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const item of items) {
    const size = JSON.stringify(item).length
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      out.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += size
  }
  if (current.length > 0) out.push(current)
  return out
}

const hues = [210, 260, 330, 20, 45, 150, 180, 290]

/** A stable cursor and avatar colour for a person. */
export function personColor(id: string): { background: string; stroke: string } {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const hue = hues[h % hues.length]!
  return { background: `hsl(${hue} 85% 92%)`, stroke: `hsl(${hue} 70% 45%)` }
}

/** A random ID for this browser window, as the server accepts it. */
export function newClientId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
