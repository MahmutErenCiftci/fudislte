// Decides when to set, refresh and clear the "coding" status. No VS Code imports: time,
// the API and the record of what was set are injected, so test/presence.test.ts drives
// the whole schedule with fake timers.
//
// Rules (docs/architecture/vscode-extension.md):
// - The first activity after being idle sets the status; while active it is refreshed
//   at most every REFRESH_MS. Every status expires by itself after STATUS_TTL_MS, so a
//   crashed editor never leaves "coding" behind for long.
// - After idleMs without activity, on exit and when sharing is turned off, the status is
//   cleared, but only if it is still exactly what this extension set.
// - A status the person set in FUDISLTE is never replaced or cleared.

import { ApiError, type Me, type PresenceApi, type ServerStatus } from './api.ts'

export const REFRESH_MS = 5 * 60_000
export const STATUS_TTL_MS = 15 * 60_000
export const RETRY_MIN_MS = 30_000
export const RETRY_MAX_MS = 15 * 60_000
const RETRY_AFTER_MAX_MS = 60 * 60_000
/** Clock differences up to this much are ignored. */
export const SKEW_TOLERANCE_MS = 60_000
export const STOP_TIMEOUT_MS = 3_000
const MAX_SENT = 3

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

// Looked up on every call so that test fake timers apply.
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

export interface Logger {
  info(message: string): void
  warn(message: string): void
}

const silent: Logger = { info: () => {}, warn: () => {} }

export interface SentStatus {
  text: string
  expiresAt: string
}

/**
 * What the extension last set, kept in VS Code's global state so every window (and the
 * next session after a crash) recognises it. Several entries are kept because an answer
 * can be lost after the server stored the status.
 */
export interface SetRecord {
  origin: string
  userId: string
  /** The window that set the latest status; only it clears on idle or exit. */
  owner: string
  sent: SentStatus[]
}

export interface RecordStore {
  get(): unknown
  set(record: SetRecord | undefined): PromiseLike<void>
}

export function parseRecord(v: unknown): SetRecord | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (typeof r.origin !== 'string' || typeof r.userId !== 'string' || typeof r.owner !== 'string' || !Array.isArray(r.sent)) return undefined
  const sent = (r.sent as unknown[])
    .filter((s): s is SentStatus => {
      const e = s as Record<string, unknown> | null
      return !!e && typeof e.text === 'string' && typeof e.expiresAt === 'string'
    })
    .map((s) => ({ text: s.text, expiresAt: s.expiresAt }))
    .slice(-MAX_SENT)
  return { origin: r.origin, userId: r.userId, owner: r.owner, sent }
}

/** True when the server's status is exactly one this extension set for this person. */
export function isOwnStatus(status: ServerStatus | null, userId: string, origin: string, record: SetRecord | undefined): boolean {
  if (!status || !record || record.origin !== origin || record.userId !== userId) return false
  if (status.kind !== 'coding' || status.expiresAt === undefined) return false
  const at = Date.parse(status.expiresAt)
  if (Number.isNaN(at)) return false
  return record.sent.some((s) => s.text === status.text && Date.parse(s.expiresAt) === at)
}

/** RFC 3339 in UTC with whole seconds, rounded up: "2026-10-30T12:15:00Z". */
export function rfc3339Seconds(ms: number): string {
  return new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

/** Exponential back-off from 30 s to 15 min with ±20 % jitter; Retry-After wins if longer. */
export function backoffDelay(failures: number, random: () => number, retryAfterMs?: number): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(Math.max(failures, 1) - 1, 10))
  const jittered = Math.min(RETRY_MAX_MS, Math.round(base * (0.8 + 0.4 * random())))
  const wanted = Math.max(jittered, Math.min(retryAfterMs ?? 0, RETRY_AFTER_MAX_MS))
  return Math.max(RETRY_MIN_MS, wanted)
}

export type PresenceState =
  | { kind: 'off' }
  | { kind: 'idle' }
  | { kind: 'sharing'; text: string; expiresAt: string }
  /** The person's own FUDISLTE status is set; the extension leaves it alone. */
  | { kind: 'yielding' }
  | { kind: 'retrying'; reason: 'network' | 'server' | 'rejected'; retryAt: number }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }

export type ClearResult = 'cleared' | 'nothing' | 'failed'

export interface ControllerOptions {
  api: PresenceApi
  origin: string
  /** Random per VS Code window. */
  windowId: string
  store: RecordStore
  /** Builds the status text from opted-in fields at the moment it is sent. */
  buildText: () => string
  idleMs: number
  clock?: Clock
  random?: () => number
  log?: Logger
}

/** sync: set or refresh when due · text: send a changed text now · idle: clear. */
type Op = 'sync' | 'text' | 'idle'

export class PresenceController {
  private readonly api: PresenceApi
  private readonly origin: string
  private readonly windowId: string
  private readonly store: RecordStore
  private readonly buildText: () => string
  private readonly clock: Clock
  private readonly random: () => number
  private readonly log: Logger
  private idleMs: number

  private enabled = false
  private stopped = false
  private state: PresenceState = { kind: 'off' }
  private lastActivity: number | null = null
  private lastSet = 0
  private lastCheck = 0
  private failures = 0
  private retryAt = 0
  private timer: unknown = undefined
  private timerAt = 0
  private queue: Promise<void> = Promise.resolve()
  private readonly queued = new Set<Op>()
  private readonly listeners = new Set<(state: PresenceState) => void>()

  constructor(o: ControllerOptions) {
    this.api = o.api
    this.origin = o.origin
    this.windowId = o.windowId
    this.store = o.store
    this.buildText = o.buildText
    this.idleMs = o.idleMs
    this.clock = o.clock ?? systemClock
    this.random = o.random ?? Math.random
    this.log = o.log ?? silent
  }

  get current(): PresenceState {
    return this.state
  }

  onDidChange(listener: (state: PresenceState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Records user activity. Called for every editor event, so it must stay cheap. */
  activity(): void {
    if (this.stopped) return
    const now = this.clock.now()
    this.lastActivity = now
    if (!this.enabled) return
    if (this.syncDue(now)) this.enqueue('sync')
    this.arm()
  }

  /** Turning sharing off clears the status at once (whichever window set it). */
  async setEnabled(on: boolean): Promise<ClearResult> {
    if (this.stopped || on === this.enabled) return 'nothing'
    this.enabled = on
    if (on) {
      this.failures = 0
      this.setState({ kind: 'idle' })
      if (this.isActive(this.clock.now())) this.enqueue('sync')
      this.arm()
      return 'nothing'
    }
    const rejected = this.state.kind === 'unauthorized' || this.state.kind === 'forbidden'
    this.disarm()
    this.setState({ kind: 'off' })
    // A rejected token cannot clear anything; the status then expires by itself.
    return rejected ? 'nothing' : this.run(() => this.clearOwn('any'))
  }

  setIdleMs(ms: number): void {
    this.idleMs = ms
    this.disarm()
    if (this.enabled && !this.stopped) this.tick()
  }

  /**
   * The opted-in fields changed (a share setting was turned off, say): update the text
   * now instead of at the next refresh, so a field that is no longer shared disappears.
   */
  refreshText(): void {
    if (this.stopped || !this.enabled || this.state.kind !== 'sharing') return
    if (this.buildText() !== this.state.text) this.enqueue('text')
  }

  /**
   * Ends this controller. 'owned' (window closing) clears only what this window set;
   * 'any' (disconnect) clears whatever this extension set. Bounded by timeoutMs: an
   * uncleared status still expires by itself.
   */
  async stop(mode: 'owned' | 'any' = 'owned', timeoutMs = STOP_TIMEOUT_MS): Promise<ClearResult> {
    if (this.stopped) return 'nothing'
    this.stopped = true
    this.disarm()
    // Let a request in flight finish, so it cannot set the status after it was cleared.
    let wait: unknown
    await Promise.race([this.queue, new Promise((resolve) => (wait = this.clock.setTimeout(() => resolve(undefined), 1000)))])
    this.clock.clearTimeout(wait)
    const rejected = this.state.kind === 'unauthorized' || this.state.kind === 'forbidden'
    const result = rejected ? 'nothing' : await this.clearOwn(mode, timeoutMs)
    this.listeners.clear()
    return result
  }

  /** Resolves once every queued request has finished (used by tests). */
  async settled(): Promise<void> {
    let q: Promise<void>
    do {
      q = this.queue
      await q
    } while (q !== this.queue)
  }

  private isActive(now: number): boolean {
    return this.lastActivity !== null && now - this.lastActivity < this.idleMs
  }

  // Checked when a sync is requested and again when it runs, so bursts of activity
  // never cause more than one update per REFRESH_MS.
  private syncDue(now: number): boolean {
    switch (this.state.kind) {
      case 'idle':
        return true
      case 'sharing':
        return now - this.lastSet >= REFRESH_MS
      case 'yielding':
        return now - this.lastCheck >= REFRESH_MS
      case 'retrying':
        return now >= this.retryAt
      default:
        return false
    }
  }

  private setState(next: PresenceState): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    for (const listener of this.listeners) listener(next)
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn)
    this.queue = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  // An operation is queued at most once at a time (queued or running). While one is
  // pending no timer is armed; the last one to finish arms the next.
  private enqueue(op: Op): void {
    if (this.queued.has(op)) return
    this.queued.add(op)
    void this.run(async () => {
      try {
        if (this.stopped || !this.enabled) return
        if (op === 'idle') await this.goIdle()
        else if (op === 'text') {
          if (this.state.kind === 'sharing' && this.buildText() !== this.state.text) await this.sync()
        } else if (this.syncDue(this.clock.now())) await this.sync()
      } finally {
        this.queued.delete(op)
        this.arm()
      }
    })
  }

  private nextDeadline(): number | null {
    if (!this.enabled || this.stopped || this.lastActivity === null) return null
    const s = this.state.kind
    if (s !== 'sharing' && s !== 'yielding' && s !== 'retrying') return null
    let next = this.lastActivity + this.idleMs
    if (s === 'sharing') next = Math.min(next, this.lastSet + REFRESH_MS)
    if (s === 'yielding') next = Math.min(next, this.lastCheck + REFRESH_MS)
    if (s === 'retrying') next = Math.min(next, this.retryAt)
    return next
  }

  // One timer at the earliest deadline. Activity only moves deadlines later, so an
  // earlier timer is kept and re-armed when it fires.
  private arm(): void {
    if (this.queued.size > 0) return
    const at = this.nextDeadline()
    if (at === null) {
      this.disarm()
      return
    }
    if (this.timer !== undefined && this.timerAt <= at) return
    this.disarm()
    this.timerAt = at
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = undefined
        this.tick()
      },
      Math.max(0, at - this.clock.now()),
    )
  }

  private disarm(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private tick(): void {
    if (this.stopped || !this.enabled) return
    const now = this.clock.now()
    const s = this.state.kind
    if (!this.isActive(now)) {
      if (s === 'sharing' || s === 'retrying') this.enqueue('idle')
      else if (s === 'yielding') this.setState({ kind: 'idle' })
      return
    }
    // From idle only new activity sets the status again.
    if (s !== 'idle' && this.syncDue(now)) this.enqueue('sync')
    this.arm()
  }

  private async sync(): Promise<void> {
    const kind = this.state.kind
    if (kind === 'unauthorized' || kind === 'forbidden') return
    try {
      const me: Me = await this.api.getMe()
      if (this.stopped || !this.enabled) return
      const record = parseRecord(this.store.get())
      if (me.status && !isOwnStatus(me.status, me.userId, this.origin, record)) {
        this.lastCheck = this.clock.now()
        this.failures = 0
        if (this.state.kind !== 'yielding') this.log.info('A status set in FUDISLTE is shown; VS Code leaves it alone.')
        this.setState({ kind: 'yielding' })
        return
      }
      const now = this.clock.now()
      const skew = me.serverTime !== null && Math.abs(me.serverTime - now) > SKEW_TOLERANCE_MS ? me.serverTime - now : 0
      const text = this.buildText()
      const expiresAt = rfc3339Seconds(now + skew + STATUS_TTL_MS)
      const earlier = record && record.origin === this.origin && record.userId === me.userId ? record.sent : []
      // Recorded before sending: if the answer is lost, the status is still recognised.
      await this.store.set({ origin: this.origin, userId: me.userId, owner: this.windowId, sent: [...earlier, { text, expiresAt }].slice(-MAX_SENT) })
      await this.api.setStatus({ kind: 'coding', text, expiresAt, mute: false })
      if (this.stopped) return
      this.lastSet = now
      this.failures = 0
      this.setState({ kind: 'sharing', text, expiresAt })
      this.log.info(`Status set: "${text}" until ${expiresAt}.`)
    } catch (err) {
      this.handleError(err)
    }
  }

  private handleError(err: unknown): void {
    if (this.stopped) return
    if (err instanceof ApiError && err.status === 401) {
      this.log.warn('The server rejected the access token (401).')
      this.setState({ kind: 'unauthorized' })
      return
    }
    if (err instanceof ApiError && err.status === 403) {
      this.log.warn(`The access token may not change the status (403 ${err.code}).`)
      this.setState({ kind: 'forbidden' })
      return
    }
    this.failures += 1
    const reason = err instanceof ApiError ? (err.status === 429 || err.status >= 500 ? 'server' : 'rejected') : 'network'
    const delay = backoffDelay(this.failures, this.random, err instanceof ApiError ? err.retryAfterMs : undefined)
    this.retryAt = this.clock.now() + delay
    this.setState({ kind: 'retrying', reason, retryAt: this.retryAt })
    this.log.warn(`${describe(err)}; next attempt in ${Math.round(delay / 1000)} s.`)
  }

  private async goIdle(): Promise<void> {
    if (this.isActive(this.clock.now())) return
    this.setState({ kind: 'idle' })
    await this.clearOwn('owned')
  }

  private async clearOwn(mode: 'owned' | 'any', timeoutMs?: number): Promise<ClearResult> {
    const record = parseRecord(this.store.get())
    if (!record || record.origin !== this.origin) return 'nothing'
    if (mode === 'owned' && record.owner !== this.windowId) return 'nothing'
    const opts = timeoutMs === undefined ? undefined : { timeoutMs }
    try {
      const me = await this.api.getMe(opts)
      let result: ClearResult = 'nothing'
      if (isOwnStatus(me.status, me.userId, this.origin, record)) {
        await this.api.clearStatus(opts)
        this.log.info('Status cleared.')
        result = 'cleared'
      }
      // Cleared, or replaced by the person: either way there is nothing left to track,
      // unless another window has taken over in the meantime.
      const latest = parseRecord(this.store.get())
      if (mode === 'any' || latest?.owner === this.windowId) await this.store.set(undefined)
      return result
    } catch (err) {
      this.log.warn(`Could not clear the status (${describe(err)}); it expires by itself within 15 minutes.`)
      return 'failed'
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status} ${err.code}`
  if (err instanceof Error) return err.message
  return String(err)
}
