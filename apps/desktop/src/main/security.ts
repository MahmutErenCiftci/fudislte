// Pure security policy for the desktop shell. Kept free of Electron imports so every
// rule is unit tested.

import path from 'node:path'

export const APP_SCHEME = 'fudislte'
export const APP_ORIGIN = `${APP_SCHEME}://app`

/**
 * scheme://host[:port] for any URL. Unlike URL.origin this also works for the custom
 * fudislte:// scheme (whose WHATWG origin is the opaque "null").
 */
export function originOf(raw: string): string | null {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}

export type ServerUrlResult = { ok: true; origin: string } | { ok: false; error: string }

/**
 * Validates what a user typed as their organization's server address. Only HTTPS is
 * accepted; plain HTTP is allowed for loopback addresses in development builds.
 */
export function normalizeServerUrl(input: string, opts: { allowInsecureLocalhost: boolean }): ServerUrlResult {
  let s = input.trim()
  if (!s) return { ok: false, error: 'Enter your server address.' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, error: 'That does not look like a valid address.' }
  }
  if (u.username || u.password) return { ok: false, error: 'Remove the user name and password from the address.' }
  if (u.protocol === 'http:') {
    if (!(opts.allowInsecureLocalhost && isLoopbackHost(u.hostname))) {
      return { ok: false, error: 'FUDISLTE requires an https:// address. Plain HTTP is only allowed for local development.' }
    }
  } else if (u.protocol !== 'https:') {
    return { ok: false, error: 'Use an https:// address.' }
  }
  return { ok: true, origin: u.origin }
}

/** Navigation inside the app window is limited to the bundled pages and the server. */
export function isAllowedNavigation(url: string, serverOrigin: string | null): boolean {
  const origin = originOf(url)
  return origin !== null && (origin === APP_ORIGIN || (serverOrigin !== null && origin === serverOrigin))
}

const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

/** Links handed to the operating system must not be able to launch local programs. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * Web permissions the server's pages may use: microphone and camera ("media") for voice
 * and video, and screen capture, whose source the person always picks in the page.
 */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen', 'media', 'display-capture'])

export function isPermissionAllowed(permission: string, requestingUrl: string, serverOrigin: string | null): boolean {
  return serverOrigin !== null && originOf(requestingUrl) === serverOrigin && ALLOWED_PERMISSIONS.has(permission)
}

/**
 * Maps a fudislte://app/<path> request to a file inside rootDir, or null when the path
 * escapes the directory.
 */
export function resolveAppFile(rootDir: string, pathname: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null
  }
  // A backslash is a separator on Windows but an ordinary character elsewhere; the
  // renderer's files never contain one (or NUL), so refuse both on every platform.
  if (/[\\\0]/.test(rel)) return null
  rel = rel.replace(/^\/+/, '') || 'connect.html'
  const root = path.resolve(rootDir)
  const file = path.resolve(root, rel)
  return file.startsWith(root + path.sep) ? file : null
}
