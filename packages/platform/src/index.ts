// Platform abstraction. Application code asks this module for host capabilities
// instead of checking for Electron itself, so the same React code runs in a browser,
// in the Electron shell, and in any future host (Tauri, Wails).

/**
 * The bridge the Electron preload script exposes as `window.fudislteDesktop`.
 * Every method is a security boundary: the main process validates the caller's
 * origin and every argument. Keep this surface small.
 *
 * The page comes from the server and is often newer than the installed shell, so every
 * method added after the first release is optional: older shells simply lack it.
 */
export interface DesktopBridge {
  readonly version: string
  readonly os: 'windows' | 'macos' | 'linux'
  /** Origin of the organization server the shell is connected to. */
  serverUrl(): Promise<string>
  /** Forget the server and return to the connect screen. */
  changeServer(): Promise<void>
  /** Open an http(s) or mailto link in the system browser. */
  openExternal(url: string): Promise<void>
  /** Screen sharing: the shell asks the page to pick a screen or window. */
  onDisplayPick?(handler: (request: DisplayPickRequest) => void): () => void
  /** Answers a pick request; null cancels the share. */
  chooseDisplaySource?(requestId: string, sourceId: string | null): Promise<void>
}

export interface DisplaySource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** A PNG data URL. */
  thumbnail: string
}

export interface DisplayPickRequest {
  id: string
  sources: DisplaySource[]
}

export interface Platform {
  kind: 'web' | 'desktop'
  /** Desktop shell version, when running in the desktop app. */
  desktopVersion?: string
  openExternal(url: string): Promise<void>
  /** Present only in the desktop app; works the same with older shells. */
  desktop?: Pick<Required<DesktopBridge>, 'serverUrl' | 'changeServer' | 'os' | 'onDisplayPick' | 'chooseDisplaySource'>
}

declare global {
  interface Window {
    fudislteDesktop?: DesktopBridge
  }
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isSafeExternalUrl(raw: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

function webPlatform(): Platform {
  return {
    kind: 'web',
    async openExternal(url) {
      if (!isSafeExternalUrl(url)) {
        throw new Error('Refusing to open an unsupported link.')
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    },
  }
}

function desktopPlatform(bridge: DesktopBridge): Platform {
  return {
    kind: 'desktop',
    desktopVersion: bridge.version,
    openExternal: (url) => bridge.openExternal(url),
    desktop: {
      os: bridge.os,
      serverUrl: () => bridge.serverUrl(),
      changeServer: () => bridge.changeServer(),
      // A shell from before screen sharing never asks for a pick: nothing to listen to.
      onDisplayPick: (handler) => bridge.onDisplayPick?.(handler) ?? (() => {}),
      chooseDisplaySource: async (id, sourceId) => bridge.chooseDisplaySource?.(id, sourceId),
    },
  }
}

let cached: Platform | undefined

export function getPlatform(): Platform {
  if (!cached) {
    const bridge = typeof window === 'undefined' ? undefined : window.fudislteDesktop
    cached = bridge ? desktopPlatform(bridge) : webPlatform()
  }
  return cached
}
