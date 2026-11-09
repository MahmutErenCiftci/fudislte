import { afterEach, describe, expect, it, vi } from 'vitest'

import { type DesktopBridge, type DisplayPickRequest, isSafeExternalUrl } from './index'

describe('isSafeExternalUrl', () => {
  it('allows web and mail links', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true)
    expect(isSafeExternalUrl('http://intranet.local')).toBe(true)
    expect(isSafeExternalUrl('mailto:it@example.com')).toBe(true)
  })

  it('rejects schemes that can execute code or touch local files', () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/system32/calc.exe', 'smb://server/share', 'vbscript:x', 'not a url']) {
      expect(isSafeExternalUrl(url)).toBe(false)
    }
  })
})

describe('getPlatform in the desktop app', () => {
  const firstRelease: DesktopBridge = {
    version: '0.1.0',
    os: 'windows',
    serverUrl: async () => 'https://fudislte.example',
    changeServer: async () => {},
    openExternal: async () => {},
  }

  /** getPlatform caches the host, so each case loads the module afresh. */
  const platformWith = async (bridge: DesktopBridge) => {
    vi.stubGlobal('window', { fudislteDesktop: bridge })
    vi.resetModules()
    return (await import('./index')).getPlatform()
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The page comes from the server and is often newer than the installed shell.
  it('works with a shell from before screen sharing', async () => {
    const desktop = (await platformWith(firstRelease)).desktop
    expect(desktop?.os).toBe('windows')
    const stop = desktop?.onDisplayPick(() => {})
    expect(stop).toBeTypeOf('function')
    stop?.()
    await expect(desktop?.chooseDisplaySource('request', null)).resolves.toBeUndefined()
  })

  it('passes screen picks through with a current shell', async () => {
    let listener: ((request: DisplayPickRequest) => void) | undefined
    const choose = vi.fn(async () => {})
    const desktop = (
      await platformWith({
        ...firstRelease,
        onDisplayPick: (handler) => {
          listener = handler
          return () => (listener = undefined)
        },
        chooseDisplaySource: choose,
      })
    ).desktop

    const seen: string[] = []
    const stop = desktop?.onDisplayPick((request) => seen.push(request.id))
    listener?.({ id: 'pick-1', sources: [] })
    stop?.()
    expect(seen).toEqual(['pick-1'])
    expect(listener).toBeUndefined()

    await desktop?.chooseDisplaySource('pick-1', 'screen:0:0')
    expect(choose).toHaveBeenCalledWith('pick-1', 'screen:0:0')
  })
})
