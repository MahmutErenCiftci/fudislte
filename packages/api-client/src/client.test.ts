import { describe, expect, it, vi } from 'vitest'

import { ApiError, createApiClient } from './client'

function fakeFetch(status: number, body?: unknown) {
  return vi.fn<typeof fetch>(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('createApiClient', () => {
  it('sends JSON with same-origin credentials and unwraps responses', async () => {
    const f = fakeFetch(200, { members: [{ user: { id: 'u1' } }] })
    const api = createApiClient({ fetch: f })
    const members = await api.members('org/1')

    expect(members).toEqual([{ user: { id: 'u1' } }])
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/v1/orgs/org%2F1/members')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.body).toBeUndefined()
  })

  it('serializes request bodies', async () => {
    const f = fakeFetch(200, { user: { id: 'u1' }, newAccount: false })
    await createApiClient({ fetch: f }).verifyCode('a@example.com', '1234 5678')
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/v1/auth/verify')
    expect(init!.method).toBe('POST')
    expect(new Headers(init!.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(init!.body as string)).toEqual({ email: 'a@example.com', code: '1234 5678' })
  })

  it('sends the current language', async () => {
    const f = fakeFetch(200, { product: 'fudislte' })
    let lang = 'tr'
    const api = createApiClient({ fetch: f, language: () => lang })
    await api.meta()
    lang = 'en'
    await api.meta()
    expect(new Headers(f.mock.calls[0]![1]!.headers).get('Accept-Language')).toBe('tr')
    expect(new Headers(f.mock.calls[1]![1]!.headers).get('Accept-Language')).toBe('en')
  })

  it('returns undefined for 204 responses', async () => {
    const api = createApiClient({ fetch: fakeFetch(204) })
    await expect(api.logout()).resolves.toBeUndefined()
  })

  it('maps API error bodies to ApiError', async () => {
    const api = createApiClient({
      fetch: fakeFetch(422, {
        error: { code: 'validation_failed', message: 'Some fields are invalid.', fields: { email: 'Bad email.' } },
      }),
    })
    const err = await api.requestCode('x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 422, code: 'validation_failed', fields: { email: 'Bad email.' } })
  })

  it('reaches meetings and their calls under the workspace', async () => {
    const f = fakeFetch(200, { meetings: [], meeting: { id: 'm1' }, voice: { url: 'wss://lk', token: 't' } })
    const api = createApiClient({ fetch: f })
    await api.meetings('o1', 'past')
    await api.cancelMeeting('o1', 'm/1')
    await api.joinMeetingVoice('o1', 'm1')
    expect(f.mock.calls.map(([url, init]) => `${init!.method} ${String(url)}`)).toEqual([
      'GET /api/v1/orgs/o1/meetings?range=past',
      'DELETE /api/v1/orgs/o1/meetings/m%2F1',
      'POST /api/v1/orgs/o1/meetings/m1/voice',
    ])
  })

  it('reports non-JSON failures and network errors', async () => {
    const html = vi.fn<typeof fetch>(async () => new Response('<html>Bad gateway</html>', { status: 502 }))
    await expect(createApiClient({ fetch: html }).meta()).rejects.toMatchObject({ status: 502, code: 'http_error' })

    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(createApiClient({ fetch: offline }).meta()).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })
})
