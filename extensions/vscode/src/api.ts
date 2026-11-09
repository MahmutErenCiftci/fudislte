// HTTP client for the FUDISLTE endpoints the extension uses (contract:
// docs/architecture/vscode-extension.md). node:http/https rather than fetch, so the
// requests carry exactly the headers listed here, redirects are never followed (the
// token must not travel to another address) and VS Code's proxy settings apply.

import * as http from 'node:http'
import * as https from 'node:https'

import { normalizeServerUrl } from './serverUrl.ts'

/** A status as GET /api/v1/me reports it. Expired statuses are already omitted. */
export interface ServerStatus {
  kind: string
  text: string
  expiresAt?: string
}

export interface Me {
  userId: string
  displayName: string
  status: ServerStatus | null
  /** The server's clock (Date header), used to correct a wrong local clock. */
  serverTime: number | null
}

/** The only body this extension ever sends. */
export interface StatusBody {
  kind: 'coding'
  text: string
  expiresAt: string
  mute: false
}

export interface CallOptions {
  timeoutMs?: number
}

export interface PresenceApi {
  getMe(opts?: CallOptions): Promise<Me>
  setStatus(body: StatusBody, opts?: CallOptions): Promise<void>
  clearStatus(opts?: CallOptions): Promise<void>
}

/** The server answered with an error status (or with something that is not FUDISLTE). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterMs: number | undefined

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/** No answer: connection refused, DNS failure, TLS error or timeout. */
export class NetworkError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`network error: ${reason}`)
    this.name = 'NetworkError'
    this.reason = reason
  }
}

export const ME_PATH = '/api/v1/me'
export const STATUS_PATH = '/api/v1/me/status'
export const META_PATH = '/api/v1/meta'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new NetworkError('response too large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', (err) => reject(toNetworkError(err)))
    })
    req.on('error', (err) => reject(toNetworkError(err)))
    req.end(body)
  })
}

function toNetworkError(err: unknown): NetworkError {
  if (err instanceof NetworkError) return err
  const e = err as { code?: unknown; name?: unknown }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return new NetworkError('timeout')
  return new NetworkError(typeof e?.code === 'string' ? e.code : 'request failed')
}

/** Retry-After in milliseconds (delta-seconds or an HTTP date), capped at one day. */
export function parseRetryAfter(value: string | string[] | undefined, now: number): number | undefined {
  const v = Array.isArray(value) ? value[0] : value
  if (!v) return undefined
  let ms: number
  if (/^\d+$/.test(v.trim())) ms = Number(v.trim()) * 1000
  else {
    const at = Date.parse(v)
    if (Number.isNaN(at)) return undefined
    ms = at - now
  }
  return ms > 0 ? Math.min(ms, 24 * 60 * 60 * 1000) : undefined
}

function errorFrom(res: RawResponse): ApiError {
  let code = `http_${res.status}`
  let message = `HTTP ${res.status}`
  try {
    const body = JSON.parse(res.body) as { error?: { code?: unknown; message?: unknown } }
    if (typeof body.error?.code === 'string') code = body.error.code.slice(0, 64)
    if (typeof body.error?.message === 'string') message = body.error.message.slice(0, 200)
  } catch {
    // Not a FUDISLTE error body (a proxy page, for example); keep the HTTP status.
  }
  return new ApiError(res.status, code, message, parseRetryAfter(res.headers['retry-after'], Date.now()))
}

function parseJson(res: RawResponse): unknown {
  try {
    return JSON.parse(res.body) as unknown
  } catch {
    throw new ApiError(res.status, 'invalid_response', 'The server did not answer like a FUDISLTE server.')
  }
}

/** Reads only the fields the extension needs from GET /api/v1/me; the rest is dropped. */
export function parseMe(res: { status: number; headers: http.IncomingHttpHeaders; body: string }): Me {
  const json = parseJson(res) as { user?: Record<string, unknown> } | null
  const user = json?.user
  if (!user || typeof user.id !== 'string' || !user.id) {
    throw new ApiError(res.status, 'invalid_response', 'The server did not answer like a FUDISLTE server.')
  }
  let status: ServerStatus | null = null
  const s = user.status as Record<string, unknown> | null | undefined
  if (s && typeof s === 'object' && typeof s.kind === 'string' && s.kind) {
    status = { kind: s.kind, text: typeof s.text === 'string' ? s.text : '' }
    if (typeof s.expiresAt === 'string') status.expiresAt = s.expiresAt
  }
  const date = res.headers.date ? Date.parse(res.headers.date) : Number.NaN
  return {
    userId: user.id,
    displayName: typeof user.displayName === 'string' ? user.displayName : '',
    status,
    serverTime: Number.isNaN(date) ? null : date,
  }
}

export interface ClientOptions {
  origin: string
  token: string
  userAgent: string
  timeoutMs?: number
}

export function createClient(options: ClientOptions): PresenceApi {
  // Checked again here so the token can never go to an address the settings would reject.
  const checked = normalizeServerUrl(options.origin)
  if (!checked.ok || checked.origin !== options.origin) throw new Error('invalid server origin')
  const origin = checked.origin
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${options.token}`,
    'User-Agent': options.userAgent,
  }

  async function call(method: string, path: string, body: string | undefined, opts: CallOptions | undefined): Promise<RawResponse> {
    const h: Record<string, string> = { ...headers }
    if (body !== undefined) {
      h['Content-Type'] = 'application/json'
      h['Content-Length'] = String(Buffer.byteLength(body))
    }
    const res = await send(new URL(path, origin), method, h, body, opts?.timeoutMs ?? timeout)
    if (res.status < 200 || res.status > 299) throw errorFrom(res)
    return res
  }

  return {
    async getMe(opts) {
      return parseMe(await call('GET', ME_PATH, undefined, opts))
    },
    async setStatus(status, opts) {
      // Built field by field: nothing else on the object can reach the request.
      const body = JSON.stringify({ kind: 'coding', text: status.text, expiresAt: status.expiresAt, mute: false })
      await call('PUT', STATUS_PATH, body, opts)
    },
    async clearStatus(opts) {
      await call('DELETE', STATUS_PATH, undefined, opts)
    },
  }
}

/** Checks that a FUDISLTE server answers at origin. Sends no token. */
export async function probeServer(origin: string, userAgent: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ version: string }> {
  const checked = normalizeServerUrl(origin)
  if (!checked.ok || checked.origin !== origin) throw new Error('invalid server origin')
  const res = await send(new URL(META_PATH, origin), 'GET', { Accept: 'application/json', 'User-Agent': userAgent }, undefined, timeoutMs)
  if (res.status < 200 || res.status > 299) throw errorFrom(res)
  const meta = parseJson(res) as { product?: unknown; version?: unknown } | null
  if (meta?.product !== 'fudislte') throw new ApiError(res.status, 'not_fudislte', 'No FUDISLTE server answered at that address.')
  return { version: typeof meta.version === 'string' ? meta.version : '' }
}
