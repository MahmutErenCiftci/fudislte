// The presence schedule under fake timers: when the status is set, refreshed, cleared and
// left alone, back-off, 401/403, several windows, and clock skew.

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import { ApiError, NetworkError, type Me, type PresenceApi, type ServerStatus, type StatusBody } from '../src/api.ts'
import {
  PresenceController,
  RETRY_MAX_MS,
  backoffDelay,
  isOwnStatus,
  parseRecord,
  rfc3339Seconds,
  systemClock,
  type PresenceState,
  type RecordStore,
  type SetRecord,
} from '../src/presence.ts'

const ORIGIN = 'https://chat.example.com'
const MIN = 60_000
const T0 = Date.parse('2026-10-30T12:00:00Z')

type Method = 'GET' | 'PUT' | 'DELETE'

/** An in-memory FUDISLTE for one person: expired statuses are omitted on read, like the API. */
class FakeFudislte implements PresenceApi {
  status: ServerStatus | null = null
  serverOffsetMs = 0
  calls: { at: number; method: Method; body?: StatusBody }[] = []
  fail: (method: Method) => Error | undefined = () => undefined

  private record(method: Method, body?: StatusBody): void {
    const err = this.fail(method)
    this.calls.push(body ? { at: Date.now() - T0, method, body } : { at: Date.now() - T0, method })
    if (err) throw err
  }

  async getMe(): Promise<Me> {
    this.record('GET')
    const now = Date.now() + this.serverOffsetMs
    const s = this.status
    const live = s && (s.expiresAt === undefined || Date.parse(s.expiresAt) > now) ? { ...s } : null
    return { userId: 'user-1', displayName: 'Dana', status: live, serverTime: now }
  }

  async setStatus(body: StatusBody): Promise<void> {
    this.record('PUT', body)
    this.status = { kind: body.kind, text: body.text, expiresAt: body.expiresAt }
  }

  async clearStatus(): Promise<void> {
    this.record('DELETE')
    this.status = null
  }

  methods(): Method[] {
    return this.calls.map((c) => c.method)
  }

  puts(): { at: number; body: StatusBody }[] {
    return this.calls.filter((c) => c.method === 'PUT').map((c) => ({ at: c.at, body: c.body! }))
  }
}

class MemoryStore implements RecordStore {
  value: SetRecord | undefined

  get(): unknown {
    return this.value
  }

  async set(record: SetRecord | undefined): Promise<void> {
    this.value = record === undefined ? undefined : structuredClone(record)
  }
}

function setup(o: { api?: FakeFudislte; store?: MemoryStore; windowId?: string; idleMinutes?: number } = {}) {
  const api = o.api ?? new FakeFudislte()
  const store = o.store ?? new MemoryStore()
  let text = 'VS Code'
  const controller = new PresenceController({
    api,
    origin: ORIGIN,
    windowId: o.windowId ?? 'window-1',
    store,
    buildText: () => text,
    idleMs: (o.idleMinutes ?? 10) * MIN,
    clock: systemClock,
    random: () => 0.5,
  })
  const states: PresenceState['kind'][] = []
  controller.onDidChange((s) => states.push(s.kind))
  return {
    api,
    store,
    controller,
    states,
    setText: (t: string) => {
      text = t
    },
  }
}

/** Lets queued requests finish, then moves the fake clock forward in steps, settling after each. */
async function advance(controllers: PresenceController[], ms: number, step = 1000): Promise<void> {
  const settle = async () => {
    for (const c of controllers) await c.settled()
  }
  await settle()
  for (let done = 0; done < ms; done += step) {
    mock.timers.tick(Math.min(step, ms - done))
    await settle()
  }
}

/** The person works: activity every `every` ms for `ms`. */
async function work(controller: PresenceController, ms: number, every = 10_000): Promise<void> {
  for (let done = 0; done < ms; done += every) {
    controller.activity()
    await advance([controller], Math.min(every, ms - done))
  }
}

const at = (calls: { at: number; method: Method }[]) => calls.map((c) => `${c.at / 1000}s ${c.method}`)

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }))
afterEach(() => mock.timers.reset())

describe('PresenceController schedule', () => {
  it('sends nothing while sharing is off', async () => {
    const { api, controller } = setup()
    await work(controller, 30 * MIN)
    assert.deepEqual(api.calls, [])
    assert.equal(controller.current.kind, 'off')
  })

  it('sets the status on the first activity, once for a burst of events', async () => {
    const { api, controller, store } = setup()
    await controller.setEnabled(true)
    for (let i = 0; i < 50; i++) controller.activity()
    await controller.settled()
    assert.deepEqual(api.methods(), ['GET', 'PUT'])
    assert.deepEqual(api.calls[1]!.body, { kind: 'coding', text: 'VS Code', expiresAt: '2026-10-30T12:15:00Z', mute: false })
    assert.deepEqual(controller.current, { kind: 'sharing', text: 'VS Code', expiresAt: '2026-10-30T12:15:00Z' })
    assert.deepEqual(store.value, {
      origin: ORIGIN,
      userId: 'user-1',
      owner: 'window-1',
      sent: [{ text: 'VS Code', expiresAt: '2026-10-30T12:15:00Z' }],
    })
  })

  it('refreshes at most every 5 minutes while the person is active', async () => {
    const { api, controller } = setup()
    await controller.setEnabled(true)
    await work(controller, 12 * MIN, 5_000)
    assert.deepEqual(
      api.puts().map((p) => [p.at / MIN, p.body.expiresAt]),
      [
        [0, '2026-10-30T12:15:00Z'],
        [5, '2026-10-30T12:20:00Z'],
        [10, '2026-10-30T12:25:00Z'],
      ],
    )
    assert.equal(api.methods().filter((m) => m === 'GET').length, 3)
  })

  it('clears its status after the idle time and sets it again on the next activity', async () => {
    const { api, controller, store } = setup()
    await controller.setEnabled(true)
    controller.activity()
    await controller.settled()
    await advance([controller], 10 * MIN - 1000)
    assert.ok(!api.methods().includes('DELETE'))
    await advance([controller], 1000)
    // Refreshed once while still within the idle time, cleared at exactly 10 minutes.
    assert.deepEqual(at(api.calls), ['0s GET', '0s PUT', '300s GET', '300s PUT', '600s GET', '600s DELETE'])
    assert.equal(api.status, null)
    assert.equal(controller.current.kind, 'idle')
    assert.equal(store.value, undefined)

    await advance([controller], 30 * MIN)
    assert.equal(api.calls.length, 6, 'nothing happens while idle')
    controller.activity()
    await controller.settled()
    assert.deepEqual(api.methods().slice(6), ['GET', 'PUT'])
  })

  it('follows fudislte.presence.idleMinutes', async () => {
    const { api, controller } = setup({ idleMinutes: 3 })
    await controller.setEnabled(true)
    controller.activity()
    await controller.settled()
    await advance([controller], 4 * MIN)
    assert.deepEqual(at(api.calls), ['0s GET', '0s PUT', '180s GET', '180s DELETE'])
    controller.setIdleMs(20 * MIN)
    controller.activity()
    await controller.settled()
    await advance([controller], 12 * MIN)
    assert.ok(!api.methods().slice(4).includes('DELETE'), 'no clear before 20 minutes')
  })

  it('never clears a status the person changed in FUDISLTE', async () => {
    for (const theirs of [
      { kind: 'meeting', text: 'Sprint planning', expiresAt: '2026-10-30T13:00:00Z' },
      // Even "coding": only the exact status this extension set counts as its own.
      { kind: 'coding', text: 'Pairing with Ali', expiresAt: '2026-10-30T13:00:00Z' },
      { kind: 'coding', text: 'VS Code' },
    ]) {
      const { api, controller } = setup()
      await controller.setEnabled(true)
      controller.activity()
      await controller.settled()
      api.status = theirs
      await advance([controller], 20 * MIN)
      // The refresh at 5 minutes finds their status and yields; going idle sends nothing.
      assert.deepEqual(at(api.calls), ['0s GET', '0s PUT', '300s GET'], theirs.text)
      assert.deepEqual(api.status, theirs)
      assert.equal(controller.current.kind, 'idle')
      assert.equal(await controller.setEnabled(false), 'nothing')
      assert.deepEqual(api.status, theirs)
      mock.timers.reset()
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 })
    }
  })

  it('does not replace a status the person set, and takes over once it has ended', async () => {
    const api = new FakeFudislte()
    api.status = { kind: 'focus', text: 'Deep work', expiresAt: '2026-10-30T12:07:00Z' }
    const { controller, states } = setup({ api })
    await controller.setEnabled(true)
    await work(controller, 12 * MIN, 30_000)
    // Checked at 0 and 5 minutes (still theirs); at 10 minutes it had expired.
    assert.deepEqual(at(api.calls), ['0s GET', '300s GET', '600s GET', '600s PUT'])
    assert.ok(states.includes('yielding'))
    assert.equal(controller.current.kind, 'sharing')
  })

  it('clears at once when sharing is turned off, then stays quiet', async () => {
    const { api, controller } = setup()
    await controller.setEnabled(true)
    controller.activity()
    await controller.settled()
    assert.equal(await controller.setEnabled(false), 'cleared')
    assert.deepEqual(api.methods(), ['GET', 'PUT', 'GET', 'DELETE'])
    assert.equal(controller.current.kind, 'off')
    await work(controller, 20 * MIN)
    assert.equal(api.calls.length, 4)
  })

  it('sends a changed text at once when the opted-in fields change', async () => {
    const s = setup()
    s.setText('VS Code · fudislte-api')
    await s.controller.setEnabled(true)
    s.controller.activity()
    await s.controller.settled()
    await advance([s.controller], 30_000)
    s.setText('VS Code')
    s.controller.refreshText()
    await s.controller.settled()
    s.controller.refreshText()
    await s.controller.settled()
    assert.deepEqual(
      s.api.puts().map((p) => [p.at, p.body.text]),
      [
        [0, 'VS Code · fudislte-api'],
        [30_000, 'VS Code'],
      ],
    )
  })

  it('clears on exit, but only a status this window set', async () => {
    const { api, controller } = setup()
    await controller.setEnabled(true)
    controller.activity()
    await controller.settled()
    assert.equal(await controller.stop(), 'cleared')
    assert.deepEqual(api.methods(), ['GET', 'PUT', 'GET', 'DELETE'])
    controller.activity()
    await advance([controller], 20 * MIN)
    assert.equal(api.calls.length, 4, 'a stopped controller sends nothing')

    const quiet = setup()
    await quiet.controller.setEnabled(true)
    assert.equal(await quiet.controller.stop(), 'nothing')
    assert.deepEqual(quiet.api.calls, [], 'nothing set, nothing sent on exit')
  })

  it('arms no timer while a request is pending, so it never spins', async () => {
    const api = new FakeFudislte()
    const getMe = api.getMe.bind(api)
    let release: () => void = () => {}
    api.getMe = async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return getMe()
    }
    let armed = 0
    const controller = new PresenceController({
      api,
      origin: ORIGIN,
      windowId: 'window-1',
      store: new MemoryStore(),
      buildText: () => 'VS Code',
      idleMs: 10 * MIN,
      random: () => 0.5,
      clock: {
        ...systemClock,
        setTimeout: (fn, ms) => {
          armed += 1
          return systemClock.setTimeout(fn, ms)
        },
      },
    })
    await controller.setEnabled(true)
    controller.activity()
    // Let the queued sync start its (blocked) request; setImmediate is not faked.
    await new Promise((resolve) => setImmediate(resolve))
    for (let i = 0; i < 100; i++) {
      controller.activity()
      mock.timers.tick(6_000)
    }
    assert.equal(armed, 0)
    release()
    await controller.settled()
    assert.equal(controller.current.kind, 'sharing')
    assert.equal(armed, 1)
  })

  it('reports a failed clear on exit and leaves the status to expire', async () => {
    const { api, controller } = setup()
    await controller.setEnabled(true)
    controller.activity()
    await controller.settled()
    api.fail = () => new NetworkError('ECONNREFUSED')
    assert.equal(await controller.stop(), 'failed')
    assert.equal(api.status?.expiresAt, '2026-10-30T12:15:00Z')
  })
})

describe('several VS Code windows', () => {
  it('recognises a status another window set and leaves clearing to whoever set it last', async () => {
    const api = new FakeFudislte()
    const store = new MemoryStore()
    const a = setup({ api, store, windowId: 'window-a' })
    const b = setup({ api, store, windowId: 'window-b' })
    await a.controller.setEnabled(true)
    await b.controller.setEnabled(true)
    a.controller.activity()
    await a.controller.settled()
    await advance([a.controller, b.controller], MIN)

    // The person moves to window B and keeps working there.
    for (let t = 0; t < 12 * MIN; t += 10_000) {
      b.controller.activity()
      await advance([a.controller, b.controller], 10_000)
    }
    assert.equal(b.controller.current.kind, 'sharing', 'B treats A’s status as its own, not as the person’s')
    assert.equal(a.controller.current.kind, 'idle')
    assert.ok(!api.methods().includes('DELETE'), 'A going idle did not clear the status B keeps up')
    assert.notEqual(api.status, null)

    assert.equal(await a.controller.stop(), 'nothing')
    assert.equal(await b.controller.stop(), 'cleared')
    assert.equal(api.status, null)
  })
})

describe('errors', () => {
  it('backs off on network errors and recovers', async () => {
    const api = new FakeFudislte()
    api.fail = () => new NetworkError('ECONNREFUSED')
    const { controller } = setup({ api })
    await controller.setEnabled(true)
    await work(controller, 8 * MIN, 5_000)
    assert.deepEqual(at(api.calls), ['0s GET', '30s GET', '90s GET', '210s GET', '450s GET'])
    assert.deepEqual(controller.current, { kind: 'retrying', reason: 'network', retryAt: T0 + 930_000 })
    api.fail = () => undefined
    await work(controller, 8 * MIN, 5_000)
    assert.deepEqual(at(api.calls).slice(5), ['930s GET', '930s PUT'])
    assert.equal(controller.current.kind, 'sharing')
  })

  it('waits as long as Retry-After asks', async () => {
    const api = new FakeFudislte()
    let first = true
    api.fail = (m) => {
      if (m !== 'GET' || !first) return undefined
      first = false
      return new ApiError(503, 'unavailable', 'Try later.', 120_000)
    }
    const { controller } = setup({ api })
    await controller.setEnabled(true)
    await work(controller, 3 * MIN, 5_000)
    assert.deepEqual(at(api.calls), ['0s GET', '120s GET', '120s PUT'])
  })

  it('stops on 401 until the person connects again', async () => {
    const api = new FakeFudislte()
    api.fail = () => new ApiError(401, 'unauthorized', 'Sign in to continue.')
    const { controller, states } = setup({ api })
    await controller.setEnabled(true)
    await work(controller, 30 * MIN)
    assert.deepEqual(api.methods(), ['GET'])
    assert.equal(controller.current.kind, 'unauthorized')
    assert.equal(states.filter((s) => s === 'unauthorized').length, 1)
    assert.equal(await controller.setEnabled(false), 'nothing')
    assert.equal(await controller.stop(), 'nothing')
    assert.deepEqual(api.methods(), ['GET'], 'a rejected token is not used again')
  })

  it('stops on 403 (token without status:write)', async () => {
    const api = new FakeFudislte()
    api.fail = (m) => (m === 'PUT' ? new ApiError(403, 'insufficient_scope', 'Not allowed.') : undefined)
    const { controller } = setup({ api })
    await controller.setEnabled(true)
    await work(controller, 20 * MIN)
    assert.deepEqual(api.methods(), ['GET', 'PUT'])
    assert.equal(controller.current.kind, 'forbidden')
  })

  it('recognises a status whose answer was lost', async () => {
    const api = new FakeFudislte()
    const original = api.setStatus.bind(api)
    let lose = true
    api.setStatus = async (body) => {
      await original(body)
      if (lose) {
        lose = false
        throw new NetworkError('ECONNRESET')
      }
    }
    const { controller } = setup({ api })
    await controller.setEnabled(true)
    await work(controller, 40_000, 5_000)
    // The retry finds the status the server did store and treats it as its own.
    assert.deepEqual(at(api.calls), ['0s GET', '0s PUT', '30s GET', '30s PUT'])
    assert.equal(controller.current.kind, 'sharing')
  })
})

describe('clock', () => {
  it('uses the server clock when the local clock is wrong', async () => {
    const api = new FakeFudislte()
    api.serverOffsetMs = 2 * 60 * MIN
    const { controller } = setup({ api })
    await controller.setEnabled(true)
    controller.activity()
    await controller.settled()
    assert.equal(api.puts()[0]!.body.expiresAt, '2026-10-30T14:15:00Z')
  })

  it('ignores differences under a minute', async () => {
    const api = new FakeFudislte()
    api.serverOffsetMs = 30_000
    const { controller } = setup({ api })
    await controller.setEnabled(true)
    controller.activity()
    await controller.settled()
    assert.equal(api.puts()[0]!.body.expiresAt, '2026-10-30T12:15:00Z')
  })
})

describe('helpers', () => {
  it('formats expiry as RFC 3339 with whole seconds, rounded up', () => {
    assert.equal(rfc3339Seconds(T0), '2026-10-30T12:00:00Z')
    assert.equal(rfc3339Seconds(T0 + 1), '2026-10-30T12:00:01Z')
  })

  it('computes back-off between 30 seconds and 15 minutes', () => {
    const mid = () => 0.5
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 20].map((n) => backoffDelay(n, mid) / 1000),
      [30, 60, 120, 240, 480, 900, 900],
    )
    assert.equal(backoffDelay(1, () => 0), 30_000)
    assert.equal(backoffDelay(3, () => 1), 144_000)
    assert.equal(backoffDelay(30, () => 1), RETRY_MAX_MS)
    assert.equal(backoffDelay(1, mid, 120_000), 120_000)
    assert.equal(backoffDelay(1, mid, 5 * 60 * MIN), 60 * MIN, 'Retry-After is capped at an hour')
  })

  it('matches only the exact status it set, for the same person and server', () => {
    const record: SetRecord = { origin: ORIGIN, userId: 'u', owner: 'w', sent: [{ text: 'VS Code', expiresAt: '2026-10-30T12:15:00Z' }] }
    const ours = { kind: 'coding', text: 'VS Code', expiresAt: '2026-10-30T15:15:00+03:00' }
    assert.equal(isOwnStatus(ours, 'u', ORIGIN, record), true, 'same instant in another offset')
    assert.equal(isOwnStatus({ ...ours, text: 'VS Code · x' }, 'u', ORIGIN, record), false)
    assert.equal(isOwnStatus({ ...ours, kind: 'focus' }, 'u', ORIGIN, record), false)
    assert.equal(isOwnStatus({ ...ours, expiresAt: '2026-10-30T12:15:01Z' }, 'u', ORIGIN, record), false)
    assert.equal(isOwnStatus({ kind: 'coding', text: 'VS Code' }, 'u', ORIGIN, record), false)
    assert.equal(isOwnStatus(ours, 'someone-else', ORIGIN, record), false)
    assert.equal(isOwnStatus(ours, 'u', 'https://other.example.com', record), false)
    assert.equal(isOwnStatus(ours, 'u', ORIGIN, undefined), false)
    assert.equal(isOwnStatus(null, 'u', ORIGIN, record), false)
  })

  it('ignores malformed stored records', () => {
    for (const bad of [undefined, null, 'x', 42, {}, { origin: ORIGIN, userId: 'u', owner: 'w' }, { origin: 1, userId: 'u', owner: 'w', sent: [] }]) {
      assert.equal(parseRecord(bad), undefined, JSON.stringify(bad))
    }
    const sent = [1, 2, 3, 4].map((n) => ({ text: `t${n}`, expiresAt: `e${n}` }))
    assert.deepEqual(parseRecord({ origin: ORIGIN, userId: 'u', owner: 'w', sent: [...sent, { text: 1 }], extra: 'dropped' }), {
      origin: ORIGIN,
      userId: 'u',
      owner: 'w',
      sent: sent.slice(1),
    })
  })
})
