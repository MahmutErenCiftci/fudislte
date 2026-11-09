// Validation of the FUDISLTE server address and of personal access tokens. Pure functions:
// no VS Code imports, so every rule is unit tested (test/serverUrl.test.ts).

export type ServerUrlError = 'empty' | 'invalid' | 'credentials' | 'insecure' | 'scheme'

export type ServerUrlResult = { ok: true; origin: string } | { ok: false; error: ServerUrlError }

/**
 * Plain HTTP is accepted only for these hosts. Subdomains of .localhost are not on the
 * list: Node resolves them through DNS, so they are not guaranteed to stay on this
 * machine, and the token would cross the network unencrypted.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Reduces what someone typed as their server address to an origin
 * ("chat.example.com/x" → "https://chat.example.com"). Only https:// is accepted;
 * http:// only for localhost, because the access token travels with every request.
 */
export function normalizeServerUrl(input: string): ServerUrlResult {
  let s = input.trim()
  if (!s) return { ok: false, error: 'empty' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, error: 'invalid' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'scheme' }
  if (!u.hostname) return { ok: false, error: 'invalid' }
  if (u.username || u.password) return { ok: false, error: 'credentials' }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return { ok: false, error: 'insecure' }
  return { ok: true, origin: u.origin }
}

export type TokenError = 'empty' | 'prefix' | 'format'

export type TokenResult = { ok: true; token: string } | { ok: false; error: TokenError }

export const TOKEN_PREFIX = 'fdp_'

/**
 * FUDISLTE personal access tokens look like "fdp_" followed by URL-safe base64. The exact
 * length is the server's business; this only rejects what can never be a token (and
 * anything that could break out of the Authorization header).
 */
export function normalizeToken(input: string): TokenResult {
  const s = input.trim()
  if (!s) return { ok: false, error: 'empty' }
  if (!s.startsWith(TOKEN_PREFIX)) return { ok: false, error: 'prefix' }
  if (!/^fdp_[A-Za-z0-9_-]{16,256}$/.test(s)) return { ok: false, error: 'format' }
  return { ok: true, token: s }
}

/** What is kept in VS Code's SecretStorage: the token and the one origin it may go to. */
export interface StoredConnection {
  origin: string
  token: string
}

export function serializeConnection(c: StoredConnection): string {
  return JSON.stringify({ origin: c.origin, token: c.token })
}

/** Parses the stored secret; anything malformed counts as "not connected". */
export function parseConnection(raw: string | undefined): StoredConnection | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { origin, token } = v as Record<string, unknown>
  if (typeof origin !== 'string' || typeof token !== 'string') return null
  const url = normalizeServerUrl(origin)
  const tok = normalizeToken(token)
  if (!url.ok || url.origin !== origin || !tok.ok) return null
  return { origin, token: tok.token }
}
