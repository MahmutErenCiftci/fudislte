import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  APP_ORIGIN,
  isAllowedNavigation,
  isPermissionAllowed,
  isSafeExternalUrl,
  normalizeServerUrl,
  originOf,
  resolveAppFile,
} from './security'

describe('normalizeServerUrl', () => {
  const prod = { allowInsecureLocalhost: false }
  const dev = { allowInsecureLocalhost: true }

  it('accepts https addresses and reduces them to an origin', () => {
    expect(normalizeServerUrl(' chat.example.com/some/path ', prod)).toEqual({ ok: true, origin: 'https://chat.example.com' })
    expect(normalizeServerUrl('https://fudislte.corp:8443', prod)).toEqual({ ok: true, origin: 'https://fudislte.corp:8443' })
  })

  it('rejects plain http except loopback in development', () => {
    expect(normalizeServerUrl('http://chat.example.com', dev).ok).toBe(false)
    expect(normalizeServerUrl('http://localhost:5173', prod).ok).toBe(false)
    expect(normalizeServerUrl('http://localhost:5173', dev)).toEqual({ ok: true, origin: 'http://localhost:5173' })
  })

  it('rejects other schemes, credentials and garbage', () => {
    for (const input of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.example', 'https://user:pw@x.example', 'https://']) {
      expect(normalizeServerUrl(input, dev).ok, input).toBe(false)
    }
  })
})

describe('navigation and permissions', () => {
  const server = 'https://chat.example.com'

  it('keeps the window on the bundled pages and the configured server', () => {
    expect(isAllowedNavigation(`${APP_ORIGIN}/connect.html`, null)).toBe(true)
    expect(isAllowedNavigation(`${server}/w/acme`, server)).toBe(true)
    expect(isAllowedNavigation('https://chat.example.com.evil.net/', server)).toBe(false)
    expect(isAllowedNavigation('http://chat.example.com/', server)).toBe(false)
    expect(isAllowedNavigation('https://evil.example/', null)).toBe(false)
  })

  it('grants only allow-listed permissions to the server origin', () => {
    expect(isPermissionAllowed('notifications', `${server}/w/acme`, server)).toBe(true)
    // Microphone, camera and screen capture for voice and video — on the server only.
    expect(isPermissionAllowed('media', `${server}/w/acme`, server)).toBe(true)
    expect(isPermissionAllowed('display-capture', `${server}/w/acme`, server)).toBe(true)
    expect(isPermissionAllowed('media', 'https://evil.example/', server)).toBe(false)
    expect(isPermissionAllowed('media', `${APP_ORIGIN}/connect.html`, server)).toBe(false)
    expect(isPermissionAllowed('geolocation', `${server}/w/acme`, server)).toBe(false)
    expect(isPermissionAllowed('notifications', 'https://evil.example/', server)).toBe(false)
    expect(isPermissionAllowed('notifications', `${APP_ORIGIN}/connect.html`, server)).toBe(false)
  })

  it('only hands web and mail links to the operating system', () => {
    expect(isSafeExternalUrl('https://docs.example.com')).toBe(true)
    expect(isSafeExternalUrl('mailto:it@example.com')).toBe(true)
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isSafeExternalUrl('ms-msdt:/id')).toBe(false)
  })

  it('computes origins for the custom scheme', () => {
    expect(originOf(`${APP_ORIGIN}/connect.html`)).toBe(APP_ORIGIN)
    expect(originOf('not a url')).toBeNull()
  })
})

describe('resolveAppFile', () => {
  const root = path.resolve('/app/renderer')

  it('serves files inside the renderer directory', () => {
    expect(resolveAppFile(root, '/connect.js')).toBe(path.join(root, 'connect.js'))
    expect(resolveAppFile(root, '/')).toBe(path.join(root, 'connect.html'))
  })

  it('blocks path traversal', () => {
    for (const p of ['/../main.cjs', '/%2e%2e/main.cjs', '/..%5cmain.cjs', '/a%5c..%5c..%5cmain.cjs', '/x%00.js', '/%E0%A4%A']) {
      expect(resolveAppFile(root, p), p).toBeNull()
    }
  })
})
