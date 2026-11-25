// Turns the web app into the browser-only demo: /api/v1 requests and the live event
// stream are answered by the in-memory backend instead of a FUDISLTE server. Imported
// before the app (see entry.ts), so the app's API client picks up the patched fetch.

import { handle, subscribe } from './backend'

// The website links here with ?lang=tr or ?lang=en: open the demo in the language the
// visitor was reading. Runs before the app's i18n reads the saved language.
const requested = new URLSearchParams(window.location.search).get('lang')
if (requested === 'tr' || requested === 'en') {
  try {
    localStorage.setItem('fudislte.language', requested)
  } catch {
    // Storage unavailable: the browser language decides.
  }
}

const API = '/api/v1'
const realFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null
  const url = new URL(request ? request.url : String(input), window.location.href)
  if (url.origin !== window.location.origin || !url.pathname.startsWith(`${API}/`)) return realFetch(input, init)
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? request?.headers)
  let body: unknown = init?.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = undefined
    }
  }
  return handle(method, url.pathname.slice(API.length), url.searchParams, body, headers.get('Accept-Language') ?? navigator.language)
}

/** The live event stream, fed by the demo backend. */
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readonly url: string
  readonly withCredentials = false
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  private unsubscribe: (() => void) | null = null

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    setTimeout(() => {
      if (this.readyState === 2) return
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
      this.unsubscribe = subscribe((type, data) => this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })))
      this.dispatchEvent(new MessageEvent('ready', { data: JSON.stringify({ connectionId: crypto.randomUUID() }) }))
    }, 0)
  }

  close() {
    this.readyState = 2
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}

globalThis.EventSource = DemoEventSource as unknown as typeof EventSource
