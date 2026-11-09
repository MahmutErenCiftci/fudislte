import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isLoopbackHost, normalizeServerUrl, normalizeToken, parseConnection, serializeConnection } from '../src/serverUrl.ts'

const TOKEN = `fdp_${'A1b2_C3d4-'.repeat(4)}xyz`

describe('normalizeServerUrl', () => {
  it('accepts https addresses and reduces them to an origin', () => {
    assert.deepEqual(normalizeServerUrl(' chat.example.com/some/path?x=1#y '), { ok: true, origin: 'https://chat.example.com' })
    assert.deepEqual(normalizeServerUrl('https://fudislte.corp:8443/'), { ok: true, origin: 'https://fudislte.corp:8443' })
    assert.deepEqual(normalizeServerUrl('HTTPS://Chat.Example.COM'), { ok: true, origin: 'https://chat.example.com' })
    assert.deepEqual(normalizeServerUrl('localhost:8080'), { ok: true, origin: 'https://localhost:8080' })
  })

  it('allows plain http only for localhost', () => {
    for (const ok of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:5173', 'http://LOCALHOST']) {
      assert.equal(normalizeServerUrl(ok).ok, true, ok)
    }
    for (const bad of [
      'http://chat.example.com',
      'http://192.168.1.10:8080',
      'http://10.0.0.1',
      'http://app.localhost:5173',
      'http://localhost.example.com',
      'http://127.0.0.1.nip.io',
    ]) {
      assert.deepEqual(normalizeServerUrl(bad), { ok: false, error: 'insecure' }, bad)
    }
  })

  it('rejects other schemes, credentials and garbage', () => {
    assert.deepEqual(normalizeServerUrl(''), { ok: false, error: 'empty' })
    assert.deepEqual(normalizeServerUrl('   '), { ok: false, error: 'empty' })
    assert.deepEqual(normalizeServerUrl('ftp://files.example.com'), { ok: false, error: 'scheme' })
    assert.deepEqual(normalizeServerUrl('file:///etc/passwd'), { ok: false, error: 'scheme' })
    assert.deepEqual(normalizeServerUrl('https://user:pw@chat.example.com'), { ok: false, error: 'credentials' })
    assert.deepEqual(normalizeServerUrl('http://user@localhost:8080'), { ok: false, error: 'credentials' })
    for (const bad of ['javascript:alert(1)', 'https://', 'https://exa mple.com', 'http://']) {
      assert.equal(normalizeServerUrl(bad).ok, false, bad)
    }
  })

  it('knows the loopback hosts', () => {
    assert.deepEqual(['localhost', '127.0.0.1', '[::1]', 'app.localhost', '127.0.0.2', 'example.com'].map(isLoopbackHost), [true, true, true, false, false, false])
  })
})

describe('normalizeToken', () => {
  it('accepts fdp_ tokens and trims pasted whitespace', () => {
    assert.deepEqual(normalizeToken(`  ${TOKEN}\n`), { ok: true, token: TOKEN })
  })

  it('rejects anything that cannot be a token', () => {
    assert.deepEqual(normalizeToken(''), { ok: false, error: 'empty' })
    assert.deepEqual(normalizeToken('ghp_0123456789abcdef0123'), { ok: false, error: 'prefix' })
    assert.deepEqual(normalizeToken('Bearer fdp_0123456789abcdef'), { ok: false, error: 'prefix' })
    assert.deepEqual(normalizeToken('fdp_short'), { ok: false, error: 'format' })
    assert.deepEqual(normalizeToken(`${TOKEN}\r\nX-Injected: 1`), { ok: false, error: 'format' })
    assert.deepEqual(normalizeToken('fdp_0123456789abcdef 0123'), { ok: false, error: 'format' })
    assert.deepEqual(normalizeToken(`fdp_${'a'.repeat(300)}`), { ok: false, error: 'format' })
  })
})

describe('stored connection', () => {
  it('round-trips the token with the one origin it may be sent to', () => {
    const c = { origin: 'https://chat.example.com', token: TOKEN }
    assert.deepEqual(parseConnection(serializeConnection(c)), c)
  })

  it('treats anything malformed as not connected', () => {
    for (const raw of [
      undefined,
      '',
      'not json',
      'null',
      '{}',
      JSON.stringify({ origin: 'https://chat.example.com/', token: TOKEN }),
      JSON.stringify({ origin: 'http://chat.example.com', token: TOKEN }),
      JSON.stringify({ origin: 'https://chat.example.com', token: 'secret' }),
      JSON.stringify({ origin: 'https://chat.example.com' }),
    ]) {
      assert.equal(parseConnection(raw), null, String(raw))
    }
  })
})
