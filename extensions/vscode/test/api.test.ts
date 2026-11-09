// The presence client against a real local HTTP server: method, path, Bearer header,
// body, error handling, and (end to end with the controller) that nothing path-like is
// ever sent. The server mimics the Go API's validation (test/helpers.ts).

import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { describe, it } from 'node:test'

import { ApiError, ME_PATH, NetworkError, createClient, parseRetryAfter, probeServer, type StatusBody } from '../src/api.ts'
import { PresenceController, type SetRecord } from '../src/presence.ts'
import { buildStatusText } from '../src/statusText.ts'
import { TOKEN, fakeFudislte, json, listen } from './helpers.ts'

const UA = 'fudislte-vscode-presence/0.1.0'
const ALLOWED_HEADERS = new Set(['host', 'connection', 'accept', 'authorization', 'user-agent', 'content-type', 'content-length'])

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('presence client', () => {
  it('sends exactly the documented requests', async () => {
    const fudislte = fakeFudislte()
    const server = await listen(fudislte.handler)
    try {
      const client = createClient({ origin: server.origin, token: TOKEN, userAgent: UA })
      const me = await client.getMe()
      assert.deepEqual(Object.keys(me).sort(), ['displayName', 'serverTime', 'status', 'userId'], 'nothing else from /me is kept')
      assert.equal(me.userId, 'user-1')
      assert.equal(me.status, null)
      assert.ok(me.serverTime !== null && Math.abs(me.serverTime - Date.now()) < 5000, 'server time from the Date header')

      const expiresAt = inMinutes(15)
      await client.setStatus({ kind: 'coding', text: 'VS Code · fudislte-api · TypeScript', expiresAt, mute: false })
      assert.deepEqual((await client.getMe()).status, { kind: 'coding', text: 'VS Code · fudislte-api · TypeScript', expiresAt })
      await client.clearStatus()
      assert.equal(fudislte.state.status, null)

      assert.deepEqual(
        server.seen.map((r) => `${r.method} ${r.url}`),
        ['GET /api/v1/me', 'PUT /api/v1/me/status', 'GET /api/v1/me', 'DELETE /api/v1/me/status'],
      )
      for (const r of server.seen) {
        assert.equal(r.headers.authorization, `Bearer ${TOKEN}`)
        assert.equal(r.headers.accept, 'application/json')
        assert.equal(r.headers['user-agent'], UA)
        for (const name of Object.keys(r.headers)) assert.ok(ALLOWED_HEADERS.has(name), `unexpected header ${name}`)
      }
      const put = server.seen[1]!
      assert.equal(put.headers['content-type'], 'application/json')
      assert.equal(Number(put.headers['content-length']), Buffer.byteLength(put.body))
      assert.deepEqual(Object.keys(JSON.parse(put.body) as object), ['kind', 'text', 'expiresAt', 'mute'])
      assert.deepEqual(JSON.parse(put.body), { kind: 'coding', text: 'VS Code · fudislte-api · TypeScript', expiresAt, mute: false })
      for (const r of [server.seen[0]!, server.seen[3]!]) {
        assert.equal(r.body, '')
        assert.equal(r.headers['content-type'], undefined)
      }
    } finally {
      await server.close()
    }
  })

  it('builds the body field by field, so nothing else on the object is sent', async () => {
    const server = await listen(fakeFudislte().handler)
    try {
      const client = createClient({ origin: server.origin, token: TOKEN, userAgent: UA })
      const body = { kind: 'coding', text: 'VS Code', expiresAt: inMinutes(15), mute: false, file: 'C:\\Users\\dana\\secret.ts' } as StatusBody
      await client.setStatus(body)
      assert.deepEqual(Object.keys(JSON.parse(server.seen[0]!.body) as object), ['kind', 'text', 'expiresAt', 'mute'])
      assert.ok(!server.seen[0]!.body.includes('secret'))
    } finally {
      await server.close()
    }
  })

  it('turns error answers into ApiError', async () => {
    let respond: (res: ServerResponse) => void = (res) => json(res, 200, {})
    const server = await listen((_req, res) => respond(res))
    try {
      const client = createClient({ origin: server.origin, token: TOKEN, userAgent: UA })
      const is = (status: number, code: string, retryAfterMs?: number) => (e: unknown) =>
        e instanceof ApiError && e.status === status && e.code === code && e.retryAfterMs === retryAfterMs

      respond = (res) => json(res, 401, { error: { code: 'unauthorized', message: 'Sign in to continue.' } })
      await assert.rejects(client.getMe(), is(401, 'unauthorized'))
      respond = (res) => json(res, 403, { error: { code: 'insufficient_scope', message: 'Not allowed.' } })
      await assert.rejects(client.clearStatus(), is(403, 'insufficient_scope'))
      respond = (res) => json(res, 422, { error: { code: 'validation_failed', message: 'Some fields are invalid.', fields: {} } })
      await assert.rejects(client.setStatus({ kind: 'coding', text: 'VS Code', expiresAt: inMinutes(15), mute: false }), is(422, 'validation_failed'))
      respond = (res) => json(res, 429, { error: { code: 'rate_limited', message: 'Wait.' } }, { 'Retry-After': '120' })
      await assert.rejects(client.getMe(), is(429, 'rate_limited', 120_000))
      respond = (res) => {
        res.writeHead(502, { 'Content-Type': 'text/html' })
        res.end('<h1>Bad gateway</h1>')
      }
      await assert.rejects(client.getMe(), is(502, 'http_502'))
      respond = (res) => json(res, 200, { hello: 'world' })
      await assert.rejects(client.getMe(), is(200, 'invalid_response'))
      respond = (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('x'.repeat(300 * 1024))
      }
      await assert.rejects(client.getMe(), (e) => e instanceof NetworkError && e.reason === 'response too large')
    } finally {
      await server.close()
    }
  })

  it('never follows redirects, so the token stays with the configured server', async () => {
    const elsewhere = await listen((_req, res) => json(res, 200, { user: { id: 'x' } }))
    const server = await listen((_req, res) => {
      res.writeHead(307, { Location: `${elsewhere.origin}${ME_PATH}` })
      res.end()
    })
    try {
      const client = createClient({ origin: server.origin, token: TOKEN, userAgent: UA })
      await assert.rejects(client.getMe(), (e) => e instanceof ApiError && e.status === 307)
      assert.equal(elsewhere.seen.length, 0)
    } finally {
      await server.close()
      await elsewhere.close()
    }
  })

  it('gives up after the timeout', async () => {
    const server = await listen(() => {
      // Never answers.
    })
    try {
      const client = createClient({ origin: server.origin, token: TOKEN, userAgent: UA, timeoutMs: 200 })
      const started = Date.now()
      await assert.rejects(client.getMe(), (e) => e instanceof NetworkError && e.reason === 'timeout')
      assert.ok(Date.now() - started < 5000)
    } finally {
      await server.close()
    }
  })

  it('reports an unreachable server as a network error', async () => {
    const server = await listen(() => {})
    const origin = server.origin
    await server.close()
    await assert.rejects(createClient({ origin, token: TOKEN, userAgent: UA }).getMe(), (e) => e instanceof NetworkError && e.reason === 'ECONNREFUSED')
  })

  it('refuses to send the token over plain http to another machine', () => {
    assert.throws(() => createClient({ origin: 'http://chat.example.com', token: TOKEN, userAgent: UA }))
    assert.throws(() => createClient({ origin: 'https://chat.example.com/sub', token: TOKEN, userAgent: UA }))
  })

  it('checks for a FUDISLTE server without sending the token', async () => {
    const server = await listen(fakeFudislte().handler)
    const other = await listen((_req, res) => json(res, 200, { product: 'something-else' }))
    try {
      assert.deepEqual(await probeServer(server.origin, UA), { version: '0.9.0' })
      assert.equal(server.seen[0]!.headers.authorization, undefined)
      await assert.rejects(probeServer(other.origin, UA), (e) => e instanceof ApiError && e.code === 'not_fudislte')
    } finally {
      await server.close()
      await other.close()
    }
  })

  it('parses Retry-After', () => {
    const now = Date.parse('2026-10-30T12:00:00Z')
    assert.equal(parseRetryAfter('30', now), 30_000)
    assert.equal(parseRetryAfter('Fri, 30 Oct 2026 12:02:00 GMT', now), 120_000)
    assert.equal(parseRetryAfter('999999', now), 24 * 3600_000)
    assert.equal(parseRetryAfter('soon', now), undefined)
    assert.equal(parseRetryAfter(undefined, now), undefined)
  })
})

describe('presence end to end against a local HTTP server', () => {
  it('sets and clears the status, and never sends path-like data', async () => {
    const fudislte = fakeFudislte()
    const server = await listen(fudislte.handler)
    let record: SetRecord | undefined
    // Workspace folder names as an odd or hostile .code-workspace file could set them.
    let projectName = 'C:\\Users\\dana\\secret-project'
    const controller = new PresenceController({
      api: createClient({ origin: server.origin, token: TOKEN, userAgent: UA }),
      origin: server.origin,
      windowId: 'window-1',
      idleMs: 10 * 60_000,
      store: {
        get: () => record,
        set: async (r) => {
          record = r
        },
      },
      buildText: () => buildStatusText({ shareProject: true, shareLanguage: true, projectName, languageId: 'typescript' }),
    })
    try {
      await controller.setEnabled(true)
      controller.activity()
      await controller.settled()
      assert.equal(fudislte.state.status?.text, 'VS Code · TypeScript')

      projectName = '/home/dana/secret-project'
      controller.refreshText()
      await controller.settled()
      projectName = 'fudislte-api'
      controller.refreshText()
      await controller.settled()
      assert.equal(fudislte.state.status?.text, 'VS Code · fudislte-api · TypeScript')

      assert.equal(await controller.stop(), 'cleared')
      assert.equal(fudislte.state.status, null)
      assert.deepEqual(
        server.seen.map((r) => `${r.method} ${r.url}`),
        ['GET /api/v1/me', 'PUT /api/v1/me/status', 'GET /api/v1/me', 'PUT /api/v1/me/status', 'GET /api/v1/me', 'DELETE /api/v1/me/status'],
      )
      for (const r of server.seen) {
        const sent = [r.method, r.url, ...Object.values(r.headers).flat(), r.body].join('\n')
        for (const fragment of ['Users', 'home', 'dana', 'secret', '\\', '.ts', 'C:']) {
          assert.ok(!sent.includes(fragment), `${r.method} ${r.url} contained ${JSON.stringify(fragment)}`)
        }
      }
    } finally {
      await controller.stop()
      await server.close()
    }
  })
})
