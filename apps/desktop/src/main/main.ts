// FUDISLTE desktop shell — main process.
//
// The shell loads the organization's own FUDISLTE server in a sandboxed window and adds
// only a few validated desktop capabilities (docs/decisions/0003). All business logic
// lives on the server and in the shared web app.

import { app, BrowserWindow, desktopCapturer, type IpcMainInvokeEvent, ipcMain, Menu, net, protocol, session, shell } from 'electron'
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
if (isDev && process.env.FUDISLTE_SMOKE_TEST) {
  app.setPath('userData', path.join(app.getPath('temp'), 'fudislte-desktop-smoke'))
}
const allowInsecureLocalhost = isDev || process.env.FUDISLTE_ALLOW_INSECURE_LOCALHOST === '1'
const rendererDir = path.join(__dirname, 'renderer')
const connectPage = `${APP_ORIGIN}/connect.html`
const pickerPage = `${APP_ORIGIN}/picker.html`

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
  // Screen sharing: the app's own picker window shows the screens and windows and the
  // person picks one, like a browser's picker. The server's page only receives the stream
  // that was picked; it never sees the other windows, their titles or thumbnails, and it
  // cannot pick for the person.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.frame || originOf(request.securityOrigin) !== serverOrigin || !mainWindow || activePick) return callback({})
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
      openPicker(mainWindow, sources, callback)
    } catch {
      callback({})
    }
  })
  ses.on('will-download', (event, item) => {
    if (originOf(item.getURL()) !== serverOrigin) event.preventDefault()
  })
}

interface ActivePick {
  sources: Electron.DesktopCapturerSource[]
  callback: (streams: Electron.Streams) => void
  window: BrowserWindow
  timer: ReturnType<typeof setTimeout>
}
let activePick: ActivePick | null = null

function openPicker(parent: BrowserWindow, sources: Electron.DesktopCapturerSource[], callback: ActivePick['callback']) {
  const window = new BrowserWindow({
    parent,
    modal: true,
    width: 760,
    height: 560,
    minWidth: 480,
    minHeight: 360,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'FUDISLTE',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
  window.setMenu(null)
  const timer = setTimeout(() => finishPick(null), 120_000)
  activePick = { sources, callback, window, timer }
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => finishPick(null))
  void window.loadURL(pickerPage)
}

/** Answers the screen-share request with the chosen source, or nothing to cancel. */
function finishPick(sourceId: string | null) {
  const pick = activePick
  if (!pick) return
  activePick = null
  clearTimeout(pick.timer)
  const source = pick.sources.find((s) => s.id === sourceId)
  // System audio comes with whole screens on Windows only.
  pick.callback(source ? { video: source, audio: process.platform === 'win32' && source.id.startsWith('screen:') ? 'loopback' : undefined } : {})
  if (!pick.window.isDestroyed()) pick.window.close()
}

/** True only for the picker page in the picker window that is open right now. */
function fromPicker(event: IpcMainInvokeEvent) {
  return activePick !== null && event.sender === activePick.window.webContents && callerOrigin(event) === APP_ORIGIN &&
    event.senderFrame?.url.startsWith(pickerPage) === true
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
      // Windows and macOS use the system spellchecker; on Linux Chromium would download
      // dictionaries from Google, and the app only talks to the organization's server.
      spellcheck: process.platform !== 'linux',
      additionalArguments: [`--fudislte-version=${app.getVersion()}`],
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  if (isDev && process.env.FUDISLTE_SMOKE_TEST === '1') runSmokeTest(mainWindow)
  if (isDev && process.env.FUDISLTE_SMOKE_TEST === 'picker') runPickerSmokeTest(mainWindow)
  if (isDev && process.env.FUDISLTE_SMOKE_TEST === 'key') runKeySmokeTest(mainWindow)
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

const MESSAGES_TR: Record<string, string> = {
  'Enter your server address.': 'Sunucu adresini girin.',
  'That does not look like a valid address.': 'Bu geçerli bir adrese benzemiyor.',
  'Remove the user name and password from the address.': 'Adresten kullanıcı adını ve şifreyi kaldırın.',
  'FUDISLTE requires an https:// address. Plain HTTP is only allowed for local development.':
    'FUDISLTE bir https:// adresi gerektirir. Düz HTTP yalnızca yerel geliştirme içindir.',
  'Use an https:// address.': 'Bir https:// adresi kullanın.',
  'No FUDISLTE server answered at that address.': 'Bu adreste bir FUDISLTE sunucusu yanıt vermedi.',
  'Could not reach that address. Check it and your network connection.':
    'Bu adrese ulaşılamadı. Adresi ve ağ bağlantınızı kontrol edin.',
  'The server did not accept the access key.': 'Sunucu erişim anahtarını kabul etmedi.',
}

/** The connect page's messages follow the system language, like the page itself. */
function localize(message: string): string {
  return app.getLocale().toLowerCase().startsWith('tr') ? (MESSAGES_TR[message] ?? message) : message
}

/**
 * Signs in with an access key during the first connection. The key goes only to the
 * server the person entered, from a hidden window on that server's own page: the request
 * is same-origin there (so it passes the server's CSRF protection) and the session cookie
 * lands in the app's session, so the main window opens signed in. The server's own
 * error message (in the system language) is shown on the connect page.
 */
async function redeemAccessKey(origin: string, key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  })
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000))
  try {
    await Promise.race([win.loadURL(origin), timeout])
    const script = `(async () => {
      const res = await fetch('/api/v1/auth/access-key', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ key: ${JSON.stringify(key)} }),
      })
      let body = null
      try { body = await res.json() } catch {}
      return { ok: res.ok, message: body && body.error && typeof body.error.message === 'string' ? body.error.message : null }
    })()`
    const answer = (await Promise.race([win.webContents.executeJavaScript(script, true), timeout])) as {
      ok: boolean
      message: string | null
    }
    if (answer.ok) return { ok: true }
    return { ok: false, error: answer.message ?? localize('The server did not accept the access key.') }
  } catch {
    return { ok: false, error: localize('Could not reach that address. Check it and your network connection.') }
  } finally {
    win.destroy()
  }
}

function registerIpc() {
  ipcMain.handle('fudislte:server:probe', (event, input: unknown) => {
    if (!fromConnectPage(event)) throw new Error('forbidden')
    return probe(input)
  })
  ipcMain.handle('fudislte:server:connect', async (event, input: unknown, key: unknown) => {
    if (!fromConnectPage(event)) throw new Error('forbidden')
    if (key !== null && key !== undefined && (typeof key !== 'string' || key.length > 64)) throw new Error('invalid')
    const result = await probe(input)
    if (!result.ok) return { ok: false, error: localize(result.error) }
    if (typeof key === 'string' && key.trim() !== '') {
      const signedIn = await redeemAccessKey(result.origin, key)
      if (!signedIn.ok) return signedIn
    }
    serverOrigin = result.origin
    saveConfig({ serverUrl: result.origin })
    void mainWindow?.loadURL(result.origin)
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
  // Pages from servers built for older shells may still call this; the app's own picker
  // answers screen-share requests now, so it does nothing.
  ipcMain.handle('fudislte:display:choose', (event) => {
    if (!fromServer(event)) throw new Error('forbidden')
  })
  ipcMain.handle('fudislte:picker:request', (event) => {
    if (!fromPicker(event) || !activePick) throw new Error('forbidden')
    return {
      server: serverOrigin ? new URL(serverOrigin).host : '',
      lang: app.getLocale().toLowerCase().startsWith('tr') ? 'tr' : 'en',
      sources: activePick.sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
      })),
    }
  })
  ipcMain.handle('fudislte:picker:choose', (event, sourceId: unknown) => {
    if (!fromPicker(event)) throw new Error('forbidden')
    if (sourceId !== null && typeof sourceId !== 'string') throw new Error('invalid')
    finishPick(sourceId)
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

/**
 * Development-only check used by `pnpm --filter @fudislte/desktop picker`: opens the
 * screen-share picker on real sources, picks the first source
 * the way a person would and prints what the request was answered with.
 */
function runPickerSmokeTest(win: BrowserWindow) {
  win.webContents.once('did-finish-load', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
    openPicker(win, sources, (streams) => {
      console.log(`FUDISLTE_PICKER_SMOKE ${JSON.stringify({ sources: sources.length, chosen: streams.video && "id" in streams.video ? streams.video.id : null, audio: streams.audio ?? null })}`)
      setTimeout(() => app.exit(streams.video ? 0 : 1), 200)
    })
    const picker = activePick?.window
    picker?.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const lead = await picker.webContents.executeJavaScript('document.getElementById("lead").textContent')
        console.log(`FUDISLTE_PICKER_LEAD ${JSON.stringify(lead)}`)
        await picker.webContents.executeJavaScript('document.querySelector(".source").click(); document.getElementById("share").click()')
      }, 1500)
    })
  })
}

/**
 * Development-only check used by `node scripts/run.mjs key`: starts signed out on the
 * connect page and connects to FUDISLTE_SMOKE_SERVER. With FUDISLTE_SMOKE_KEY it first
 * tries a wrong key, then signs in with the real one; without, it connects only. It
 * prints where the app ended up and whether the server sees a signed-in user.
 */
function runKeySmokeTest(win: BrowserWindow) {
  const server = process.env.FUDISLTE_SMOKE_SERVER ?? ''
  const key = process.env.FUDISLTE_SMOKE_KEY ?? ''
  const fill = (k: string) =>
    win.webContents.executeJavaScript(`(async () => {
      const row = document.querySelector('#key-row')
      if (row.hidden === ${JSON.stringify(k !== '')}) document.querySelector('#toggle-key').click()
      document.querySelector('#server').value = ${JSON.stringify(server)}
      if (${JSON.stringify(k !== '')}) document.querySelector('#key').value = ${JSON.stringify(k)}
      document.querySelector('form').requestSubmit()
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 200))
        const error = document.querySelector('#error')
        if (!error) return ''
        if (error.textContent) return error.textContent
      }
      return 'timeout'
    })()`)
  const report = async () => {
    const me = await win.webContents.executeJavaScript(
      `fetch('/api/v1/me').then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`,
    )
    await new Promise((r) => setTimeout(r, 1500)) // let the web app route
    const email = me?.body?.user?.email ?? null
    console.log(`FUDISLTE_KEY_SMOKE ${JSON.stringify({ url: win.webContents.getURL(), status: me.status, email, saved: loadConfig().serverUrl })}`)
    app.exit(key ? (me.status === 200 && email ? 0 : 1) : me.status === 401 ? 0 : 1)
  }
  const onConnectPage = async (): Promise<void> => {
    if (!win.webContents.getURL().startsWith(connectPage)) {
      win.webContents.once('did-finish-load', () => void onConnectPage())
      return
    }
    if (process.env.FUDISLTE_SMOKE_SHOT) {
      await win.webContents.executeJavaScript(`document.querySelector('#toggle-key').click()`)
      await new Promise((r) => setTimeout(r, 300))
      const { writeFile } = await import('node:fs/promises')
      await writeFile(process.env.FUDISLTE_SMOKE_SHOT, (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript(`document.querySelector('#toggle-key').click()`)
    }
    if (key) {
      const wrong = await fill('ABCDE-12345-FGHJK-67890')
      console.log(`FUDISLTE_KEY_SMOKE_WRONG ${JSON.stringify(wrong)}`)
    }
    win.webContents.once('did-finish-load', () => void report())
    const error = await fill(key).catch(() => "") // the page is replaced on success
    if (error) {
      console.log(`FUDISLTE_KEY_SMOKE ${JSON.stringify({ error })}`)
      app.exit(1)
    }
  }
  void session.defaultSession.clearStorageData().then(() => {
    saveConfig({})
    serverOrigin = null
    win.webContents.once('did-finish-load', () => void onConnectPage())
    void win.loadURL(connectPage)
  })
}
