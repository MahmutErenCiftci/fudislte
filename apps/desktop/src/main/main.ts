// FUDISLTE desktop shell — main process.
//
// The shell loads the organization's own FUDISLTE server in a sandboxed window and adds
// only a few validated desktop capabilities (docs/decisions/0003). All business logic
// lives on the server and in the shared web app.

import { app, BrowserWindow, desktopCapturer, type IpcMainInvokeEvent, ipcMain, Menu, net, protocol, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { loadConfig, saveConfig } from './config'
import {
  APP_ORIGIN,
  APP_SCHEME,
  isAllowedNavigation,
  isPermissionAllowed,
  isSafeExternalUrl,
  normalizeServerUrl,
  originOf,
  resolveAppFile,
} from './security'

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }])
app.enableSandbox()

const isDev = !app.isPackaged
// The smoke test runs beside a developer's open window: give it its own profile so the
// single-instance lock and the stored server address do not collide.
if (isDev && process.env.FUDISLTE_SMOKE_TEST === '1') {
  app.setPath('userData', path.join(app.getPath('temp'), 'fudislte-desktop-smoke'))
}
const allowInsecureLocalhost = isDev || process.env.FUDISLTE_ALLOW_INSECURE_LOCALHOST === '1'
const rendererDir = path.join(__dirname, 'renderer')
const connectPage = `${APP_ORIGIN}/connect.html`

/** Development override, e.g. http://localhost:5173 (the Vite dev server). */
const devServer = isDev && process.env.FUDISLTE_DEV_SERVER_URL ? normalizeServerUrl(process.env.FUDISLTE_DEV_SERVER_URL, { allowInsecureLocalhost }) : null

let serverOrigin: string | null = devServer?.ok ? devServer.origin : (loadConfig().serverUrl ?? null)
let mainWindow: BrowserWindow | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(start)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

async function start() {
  registerAppProtocol()
  configureSession()
  registerIpc()
  Menu.setApplicationMenu(buildMenu())
  createWindow()
}

const CONNECT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** Serves the bundled connect page from fudislte://app instead of file://. */
function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const file = url.host === 'app' ? resolveAppFile(rendererDir, url.pathname) : null
    const body = file ? await readFile(file).catch(() => null) : null
    if (!file || !body) return new Response('Not found', { status: 404 })
    return new Response(body, {
      headers: {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': CONNECT_CSP,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
}

function configureSession() {
  const ses = session.defaultSession
  ses.setUserAgent(`${ses.getUserAgent()} FudislteDesktop/${app.getVersion()}`)
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl, serverOrigin))
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, serverOrigin),
  )
  // Screen sharing: the page shows the screens and windows, the person picks one.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const frame = request.frame
    if (!frame || originOf(request.securityOrigin) !== serverOrigin) return callback({})
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
      const id = randomUUID()
      const timer = setTimeout(() => finishPick(id, null), 120_000)
      pendingPicks.set(id, { sources, callback, timer })
      frame.send('fudislte:display:pick', {
        id,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: s.thumbnail.toDataURL(),
        })),
      })
    } catch {
      callback({})
    }
  })
  ses.on('will-download', (event, item) => {
    if (originOf(item.getURL()) !== serverOrigin) event.preventDefault()
  })
}

interface PendingPick {
  sources: Electron.DesktopCapturerSource[]
  callback: (streams: Electron.Streams) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingPicks = new Map<string, PendingPick>()

/** Answers a screen-share request: the chosen source, or nothing to cancel. */
function finishPick(id: string, sourceId: string | null) {
  const pick = pendingPicks.get(id)
  if (!pick) return
  pendingPicks.delete(id)
  clearTimeout(pick.timer)
  const source = pick.sources.find((s) => s.id === sourceId)
  // System audio comes with whole screens on Windows only.
  pick.callback(source ? { video: source, audio: process.platform === 'win32' && source.id.startsWith('screen:') ? 'loopback' : undefined } : {})
}

function openExternal(url: string) {
  if (isSafeExternalUrl(url)) void shell.openExternal(url)
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  const guard = (event: Electron.Event, url: string) => {
    if (!isAllowedNavigation(url, serverOrigin)) {
      event.preventDefault()
      openExternal(url)
    }
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'FUDISLTE',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      additionalArguments: [`--fudislte-version=${app.getVersion()}`],
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  if (isDev && process.env.FUDISLTE_SMOKE_TEST === '1') runSmokeTest(mainWindow)
  void mainWindow.loadURL(serverOrigin ?? connectPage)
}

function showConnectPage() {
  serverOrigin = null
  saveConfig({})
  void mainWindow?.loadURL(connectPage)
}

// IPC: every handler checks which page is calling and validates its arguments.

function callerOrigin(event: IpcMainInvokeEvent): string | null {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) return null // main frames only, never iframes
  return originOf(frame.url)
}

function fromConnectPage(event: IpcMainInvokeEvent) {
  return callerOrigin(event) === APP_ORIGIN
}

function fromServer(event: IpcMainInvokeEvent) {
  return serverOrigin !== null && callerOrigin(event) === serverOrigin
}

type ProbeResult = { ok: true; origin: string; version: string } | { ok: false; error: string }

async function probe(input: unknown): Promise<ProbeResult> {
  if (typeof input !== 'string' || input.length > 2048) return { ok: false, error: 'Enter your server address.' }
  const normalized = normalizeServerUrl(input, { allowInsecureLocalhost })
  if (!normalized.ok) return normalized
  try {
    const res = await net.fetch(`${normalized.origin}/api/v1/meta`, { signal: AbortSignal.timeout(8000), redirect: 'error' })
    const meta = (await res.json()) as { product?: unknown; version?: unknown }
    if (!res.ok || meta.product !== 'fudislte') return { ok: false, error: 'No FUDISLTE server answered at that address.' }
    return { ok: true, origin: normalized.origin, version: String(meta.version ?? '') }
  } catch {
    return { ok: false, error: 'Could not reach that address. Check it and your network connection.' }
  }
}

function registerIpc() {
  ipcMain.handle('fudislte:server:probe', (event, input: unknown) => {
    if (!fromConnectPage(event)) throw new Error('forbidden')
    return probe(input)
  })
  ipcMain.handle('fudislte:server:connect', async (event, input: unknown) => {
    if (!fromConnectPage(event)) throw new Error('forbidden')
    const result = await probe(input)
    if (result.ok) {
      serverOrigin = result.origin
      saveConfig({ serverUrl: result.origin })
      void mainWindow?.loadURL(result.origin)
    }
    return result
  })
  ipcMain.handle('fudislte:server:get', (event) => {
    if (!fromServer(event)) throw new Error('forbidden')
    return serverOrigin
  })
  ipcMain.handle('fudislte:server:change', (event) => {
    if (!fromServer(event)) throw new Error('forbidden')
    showConnectPage()
  })
  ipcMain.handle('fudislte:display:choose', (event, id: unknown, sourceId: unknown) => {
    if (!fromServer(event)) throw new Error('forbidden')
    if (typeof id !== 'string' || (sourceId !== null && typeof sourceId !== 'string')) throw new Error('invalid')
    finishPick(id, sourceId)
  })
  ipcMain.handle('fudislte:shell:open-external', (event, url: unknown) => {
    if (!fromServer(event) && !fromConnectPage(event)) throw new Error('forbidden')
    if (typeof url !== 'string' || !isSafeExternalUrl(url)) throw new Error('unsupported link')
    return shell.openExternal(url)
  })
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [{ label: 'Change server…', click: showConnectPage }, { type: 'separator' }, { role: 'quit' }],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  return Menu.buildFromTemplate(template)
}

/**
 * Development-only check used by `pnpm --filter @fudislte/desktop smoke`: verifies that the
 * loaded page has the bridge but no Node.js access, prints the result and exits.
 */
function runSmokeTest(win: BrowserWindow) {
  win.webContents.once('did-finish-load', async () => {
    const result = (await win.webContents.executeJavaScript(`({
      url: location.href,
      title: document.title,
      bridge: typeof window.fudislteDesktop === 'object' && Object.keys(window.fudislteDesktop).sort(),
      connectApi: typeof window.fudislteConnect,
      nodeRequire: typeof window.require,
      nodeProcess: typeof window.process,
    })`)) as Record<string, unknown>
    const serverUrl = await win.webContents
      .executeJavaScript('window.fudislteDesktop ? window.fudislteDesktop.serverUrl() : null')
      .catch((e: unknown) => `error: ${String(e)}`)
    const blockedNavigation = !isAllowedNavigation('https://evil.example/', serverOrigin)
    console.log(`FUDISLTE_SMOKE ${JSON.stringify({ ...result, serverUrl, blockedNavigation })}`)
    app.exit(result.nodeRequire === 'undefined' && result.nodeProcess === 'undefined' ? 0 : 1)
  })
}
