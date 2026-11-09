// Shared by the HTTP tests: a local HTTP server that records every request and a
// stand-in for the FUDISLTE endpoints the extension uses, validating like the Go API
// (services/api/internal/presence/presence.go, httpx.DecodeJSON).

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ME_PATH, STATUS_PATH } from '../src/api.ts'

export const TOKEN = `fdp_${'k3Y-'.repeat(10)}abc`

export interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

export type Handler = (req: Seen, res: ServerResponse) => void

export interface TestServer {
  origin: string
  seen: Seen[]
  close: () => Promise<void>
}

export async function listen(handler: Handler): Promise<TestServer> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      handler(s, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export interface FakeFudislte {
  state: { status: { kind: string; text: string; expiresAt?: string } | null; token: string }
  handler: Handler
}

/** GET /api/v1/meta, GET /api/v1/me and PUT/DELETE /api/v1/me/status for one person. */
export function fakeFudislte(): FakeFudislte {
  const state: FakeFudislte['state'] = { status: null, token: TOKEN }
  const invalidJson = { error: { code: 'invalid_json', message: 'Request body must be a valid JSON object with known fields.' } }
  const handler: Handler = (req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/meta') {
      json(res, 200, { product: 'fudislte', version: '0.9.0', setupRequired: false })
      return
    }
    if (req.headers.authorization !== `Bearer ${state.token}`) {
      json(res, 401, { error: { code: 'unauthorized', message: 'Sign in to continue.' } })
      return
    }
    if (req.method === 'GET' && req.url === ME_PATH) {
      const user = { id: 'user-1', email: 'dana@example.com', displayName: 'Dana Yılmaz', locale: 'tr', isInstanceAdmin: false }
      const live = state.status && (!state.status.expiresAt || Date.parse(state.status.expiresAt) > Date.now()) ? state.status : null
      json(res, 200, { user: live ? { ...user, status: { ...live, mute: false } } : user, workspaces: [{ id: 'org-1', name: 'Acme' }] })
      return
    }
    if (req.method === 'PUT' && req.url === STATUS_PATH) {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(req.body) as Record<string, unknown>
      } catch {
        json(res, 400, invalidJson)
        return
      }
      const known = ['kind', 'text', 'expiresAt', 'mute']
      if (
        typeof body !== 'object' ||
        body === null ||
        Object.keys(body).some((k) => !known.includes(k)) ||
        (body.expiresAt !== undefined && (typeof body.expiresAt !== 'string' || !RFC3339.test(body.expiresAt))) ||
        (body.mute !== undefined && typeof body.mute !== 'boolean')
      ) {
        json(res, 400, invalidJson)
        return
      }
      const text = String(body.text ?? '')
        .split(/[\s\u0000-\u001F\u007F-\u009F]+/u)
        .filter(Boolean)
        .join(' ')
      const fields: Record<string, string> = {}
      if (!['meeting', 'coding', 'focus', 'call', 'custom'].includes(String(body.kind))) fields.kind = 'Choose a status.'
      if (Array.from(text).length > 100) fields.text = 'Use at most 100 characters.'
      const exp = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : undefined
      if (exp !== undefined && (exp <= Date.now() || exp > Date.now() + 30 * 24 * 3600_000)) fields.expiresAt = 'Choose a time within the next 30 days.'
      if (Object.keys(fields).length > 0) {
        json(res, 422, { error: { code: 'validation_failed', message: 'Some fields are invalid.', fields } })
        return
      }
      state.status = { kind: String(body.kind), text, ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}) }
      json(res, 200, { status: { ...state.status, mute: body.mute === true } })
      return
    }
    if (req.method === 'DELETE' && req.url === STATUS_PATH) {
      state.status = null
      res.writeHead(204)
      res.end()
      return
    }
    json(res, 404, { error: { code: 'not_found', message: 'Not found.' } })
  }
  return { state, handler }
}

/** Polls until check() is true; fails after timeoutMs. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
