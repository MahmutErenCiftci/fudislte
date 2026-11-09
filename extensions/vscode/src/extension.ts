// VS Code wiring for FUDISLTE Presence: settings, SecretStorage, commands, the status bar
// item and the editor events that count as activity. The decisions live in the pure
// modules (presence.ts, statusText.ts, serverUrl.ts, api.ts), which are unit tested.
//
// Editor events are used only to note *that* the person is working: no event data (file
// names, paths, contents, keystrokes) is read, stored or sent.

import { randomUUID } from 'node:crypto'

import * as vscode from 'vscode'

import { ApiError, NetworkError, createClient, probeServer, type Me } from './api.ts'
import { PresenceController, type ClearResult, type PresenceState } from './presence.ts'
import {
  normalizeServerUrl,
  normalizeToken,
  parseConnection,
  serializeConnection,
  type ServerUrlError,
  type StoredConnection,
  type TokenError,
} from './serverUrl.ts'
import { buildStatusText } from './statusText.ts'

const SECRET_KEY = 'fudislte.connection'
const RECORD_KEY = 'fudislte.presence.lastSet'
const EXPLAINED_KEY = 'fudislte.presence.explained'

interface Settings {
  serverUrl: string
  enabled: boolean
  shareProject: boolean
  shareLanguage: boolean
  idleMinutes: number
}

// Every setting has "application" scope: only user settings count, so a repository's
// .vscode/settings.json can neither turn sharing on nor send the token elsewhere.
function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('fudislte')
  const idle = c.get<number>('presence.idleMinutes', 10)
  return {
    serverUrl: c.get<string>('serverUrl', ''),
    enabled: c.get<boolean>('presence.enabled', false) === true,
    shareProject: c.get<boolean>('presence.shareProject', false) === true,
    shareLanguage: c.get<boolean>('presence.shareLanguage', false) === true,
    idleMinutes: Number.isFinite(idle) ? Math.min(120, Math.max(1, Math.round(idle))) : 10,
  }
}

/** The workspace folder of the active editor, or the first folder. Read only when shared. */
function currentFolderName(): string | undefined {
  const editor = vscode.window.activeTextEditor
  const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ?? vscode.workspace.workspaceFolders?.[0]
  return folder?.name
}

// Language ids of panels (output, git views, settings UI) are not shared.
const CODE_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-notebook-cell'])

/** The language id of the active editor. Read only when shared. */
function currentLanguageId(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document
  if (!doc || !CODE_SCHEMES.has(doc.uri.scheme)) return undefined
  return doc.languageId
}

function serverUrlMessage(e: ServerUrlError): string {
  switch (e) {
    case 'empty':
      return vscode.l10n.t('Enter the address of your FUDISLTE server.')
    case 'invalid':
      return vscode.l10n.t('That does not look like a valid address.')
    case 'credentials':
      return vscode.l10n.t('Remove the user name and password from the address.')
    case 'insecure':
      return vscode.l10n.t('Use an https:// address. Plain http:// is allowed only for localhost.')
    case 'scheme':
      return vscode.l10n.t('Use an https:// address.')
  }
}

function tokenMessage(e: TokenError): string {
  switch (e) {
    case 'empty':
      return vscode.l10n.t('Paste your personal access token.')
    case 'prefix':
      return vscode.l10n.t('FUDISLTE personal access tokens start with fdp_.')
    case 'format':
      return vscode.l10n.t('That does not look like a FUDISLTE personal access token.')
  }
}

function connectErrorMessage(err: unknown, origin: string): string {
  if (err instanceof ApiError && err.status === 401) {
    return vscode.l10n.t('FUDISLTE did not accept the token. Check that it is complete and has not expired or been revoked.')
  }
  if (err instanceof ApiError && err.status === 403) {
    return vscode.l10n.t('This token may not be used here. Create one with the status:write scope.')
  }
  if (err instanceof NetworkError) {
    return vscode.l10n.t('Could not reach {0}. Check the address and your network connection.', origin)
  }
  return vscode.l10n.t('The FUDISLTE server answered with an error ({0}). Try again later.', err instanceof ApiError ? String(err.status) : '?')
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task)
}

type UiState = { kind: 'disconnected' } | { kind: 'mismatch' } | PresenceState

class App implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext
  private readonly log: vscode.LogOutputChannel
  private readonly item: vscode.StatusBarItem
  private readonly userAgent: string
  private readonly windowId = randomUUID()
  private controller: PresenceController | undefined
  private connection: StoredConnection | null = null
  private mismatch = false
  private notified = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(context: vscode.ExtensionContext, log: vscode.LogOutputChannel, item: vscode.StatusBarItem) {
    this.context = context
    this.log = log
    this.item = item
    const version = (context.extension.packageJSON as { version?: unknown }).version
    this.userAgent = `fudislte-vscode-presence/${typeof version === 'string' ? version : '0'}`
  }

  dispose(): void {
    this.item.dispose()
  }

  /** Runs connection changes one at a time (settings and secrets change concurrently). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch((err: unknown) => this.log.error(String(err)))
    return p
  }

  activity(): void {
    this.controller?.activity()
  }

  /** Re-reads settings and the stored token. Errors are logged by serial(). */
  reload(): Promise<void> {
    return this.serial(() => this.doReload()).catch(() => undefined)
  }

  private async doReload(): Promise<void> {
    const settings = readSettings()
    const stored = parseConnection(await this.context.secrets.get(SECRET_KEY))
    const url = normalizeServerUrl(settings.serverUrl)
    // The token goes only to the server it was entered for.
    const usable = stored && url.ok && url.origin === stored.origin ? stored : null
    this.mismatch = stored !== null && usable === null
    if (usable?.origin !== this.connection?.origin || usable?.token !== this.connection?.token) {
      await this.controller?.stop('owned')
      this.controller = undefined
      this.connection = usable
      this.notified = false
      if (usable) this.controller = this.createController(usable, settings)
    }
    if (this.controller) {
      this.controller.setIdleMs(settings.idleMinutes * 60_000)
      const result = await this.controller.setEnabled(settings.enabled)
      this.warnIfNotCleared(result)
      this.controller.refreshText()
    }
    this.render()
  }

  private createController(connection: StoredConnection, settings: Settings): PresenceController {
    const controller = new PresenceController({
      api: createClient({ origin: connection.origin, token: connection.token, userAgent: this.userAgent }),
      origin: connection.origin,
      windowId: this.windowId,
      store: {
        get: () => this.context.globalState.get(RECORD_KEY),
        set: (record) => this.context.globalState.update(RECORD_KEY, record),
      },
      buildText: () => this.statusText(),
      idleMs: settings.idleMinutes * 60_000,
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m) },
    })
    controller.onDidChange((state) => this.onState(state))
    return controller
  }

  /** The text sent to FUDISLTE, from opted-in fields only. */
  statusText(): string {
    const s = readSettings()
    return buildStatusText({
      shareProject: s.shareProject,
      shareLanguage: s.shareLanguage,
      projectName: s.shareProject ? currentFolderName() : undefined,
      languageId: s.shareLanguage ? currentLanguageId() : undefined,
    })
  }

  private onState(state: PresenceState): void {
    this.render()
    if ((state.kind !== 'unauthorized' && state.kind !== 'forbidden') || this.notified) return
    this.notified = true
    const connect = vscode.l10n.t('Connect')
    const message =
      state.kind === 'unauthorized'
        ? vscode.l10n.t('FUDISLTE rejected the access token, so your status is no longer shared. Connect again with a new token.')
        : vscode.l10n.t('This access token may not change your FUDISLTE status. Connect again with a token that has the status:write scope.')
    void vscode.window.showWarningMessage(message, connect).then((choice) => {
      if (choice === connect) void vscode.commands.executeCommand('fudislte.connect')
    })
  }

  private warnIfNotCleared(result: ClearResult): void {
    if (result !== 'failed') return
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Your FUDISLTE status could not be cleared because the server did not answer. It ends by itself within 15 minutes.'),
    )
  }

  private uiState(): UiState {
    if (this.controller) return this.controller.current
    return this.mismatch ? { kind: 'mismatch' } : { kind: 'disconnected' }
  }

  render(): void {
    const item = this.item
    const state = this.uiState()
    let tooltip: string
    item.command = 'fudislte.togglePresence'
    item.backgroundColor = undefined
    switch (state.kind) {
      case 'disconnected':
        item.text = '$(plug) FUDISLTE'
        tooltip = vscode.l10n.t('FUDISLTE is not connected. Click to connect.')
        item.command = 'fudislte.connect'
        break
      case 'mismatch':
        item.text = '$(warning) FUDISLTE'
        tooltip = vscode.l10n.t('The FUDISLTE server address changed. Click to connect again.')
        item.command = 'fudislte.connect'
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
        break
      case 'off':
        item.text = '$(circle-slash) FUDISLTE'
        tooltip = vscode.l10n.t('Presence sharing is off. Click to show in FUDISLTE that you are coding.')
        break
      case 'idle':
        item.text = '$(debug-pause) FUDISLTE'
        tooltip = vscode.l10n.t('Presence sharing is on. Nothing is shown while you are idle. Click to turn sharing off.')
        break
      case 'sharing':
        item.text = '$(broadcast) FUDISLTE'
        tooltip = vscode.l10n.t('Shown in FUDISLTE: Coding, "{0}". Click to turn sharing off.', state.text)
        break
      case 'yielding':
        item.text = '$(person) FUDISLTE'
        tooltip = vscode.l10n.t('A status you set in FUDISLTE is shown, so VS Code leaves it alone. Click to turn sharing off.')
        break
      case 'retrying': {
        const at = new Date(state.retryAt).toLocaleTimeString(vscode.env.language, { hour: '2-digit', minute: '2-digit' })
        item.text = '$(warning) FUDISLTE'
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
        tooltip =
          state.reason === 'network'
            ? vscode.l10n.t('Cannot reach the FUDISLTE server. Next attempt at {0}.', at)
            : state.reason === 'server'
              ? vscode.l10n.t('The FUDISLTE server is not available. Next attempt at {0}.', at)
              : vscode.l10n.t('The FUDISLTE server refused the status. Next attempt at {0}.', at)
        break
      }
      case 'unauthorized':
        item.text = '$(error) FUDISLTE'
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
        item.command = 'fudislte.connect'
        tooltip = vscode.l10n.t('FUDISLTE rejected the access token. Click to connect again.')
        break
      case 'forbidden':
        item.text = '$(error) FUDISLTE'
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
        item.command = 'fudislte.connect'
        tooltip = vscode.l10n.t('The access token may not change your status (it needs the status:write scope). Click to connect again.')
        break
    }
    item.tooltip = tooltip
    item.accessibilityInformation = { label: tooltip }
    item.show()
  }

  async connect(): Promise<void> {
    const title = vscode.l10n.t('Connect to FUDISLTE')
    const current = readSettings().serverUrl
    const address = await vscode.window.showInputBox({
      title,
      prompt: vscode.l10n.t('Address of your FUDISLTE server'),
      value: current || 'https://',
      placeHolder: 'https://chat.example.com',
      ignoreFocusOut: true,
      validateInput: (v) => {
        const r = normalizeServerUrl(v)
        return r.ok ? undefined : serverUrlMessage(r.error)
      },
    })
    if (address === undefined) return
    const url = normalizeServerUrl(address)
    if (!url.ok) return
    const origin = url.origin
    try {
      await withProgress(vscode.l10n.t('Checking {0}…', origin), () => probeServer(origin, this.userAgent))
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof NetworkError
          ? vscode.l10n.t('Could not reach {0}. Check the address and your network connection.', origin)
          : vscode.l10n.t('No FUDISLTE server answered at {0}.', origin),
      )
      return
    }
    const input = await vscode.window.showInputBox({
      title,
      prompt: vscode.l10n.t('Personal access token with the status:write scope. It is kept only in the VS Code secret storage of this computer.'),
      placeHolder: 'fdp_…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => {
        const r = normalizeToken(v)
        return r.ok ? undefined : tokenMessage(r.error)
      },
    })
    if (input === undefined) return
    const token = normalizeToken(input)
    if (!token.ok) return
    let me: Me
    try {
      me = await withProgress(vscode.l10n.t('Checking the token…'), () =>
        createClient({ origin, token: token.token, userAgent: this.userAgent }).getMe(),
      )
    } catch (err) {
      void vscode.window.showErrorMessage(connectErrorMessage(err, origin))
      return
    }
    await this.serial(async () => {
      await vscode.workspace.getConfiguration('fudislte').update('serverUrl', origin, vscode.ConfigurationTarget.Global)
      await this.context.secrets.store(SECRET_KEY, serializeConnection({ origin, token: token.token }))
    })
    await this.reload()
    const host = new URL(origin).host
    const name = me.displayName || me.userId
    if (readSettings().enabled) {
      this.controller?.activity()
      void vscode.window.showInformationMessage(vscode.l10n.t('Connected to {0} as {1}.', host, name))
      return
    }
    const share = vscode.l10n.t('Share while I work')
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('Connected to {0} as {1}. Presence sharing is off until you turn it on.', host, name),
      share,
    )
    if (choice === share) await this.setSharing(true)
  }

  async disconnect(): Promise<void> {
    const had = this.connection !== null || (await this.context.secrets.get(SECRET_KEY)) !== undefined
    if (!had) {
      void vscode.window.showInformationMessage(vscode.l10n.t('FUDISLTE is not connected.'))
      return
    }
    const result = await this.serial(async () => {
      const r = (await this.controller?.stop('any')) ?? 'nothing'
      this.controller = undefined
      this.connection = null
      this.mismatch = false
      await this.context.secrets.delete(SECRET_KEY)
      await this.context.globalState.update(RECORD_KEY, undefined)
      return r
    })
    this.render()
    void vscode.window.showInformationMessage(
      result === 'failed'
        ? vscode.l10n.t('Disconnected. Your FUDISLTE status could not be cleared; it ends by itself within 15 minutes.')
        : vscode.l10n.t('Disconnected from FUDISLTE. The access token was removed from this computer.'),
    )
  }

  async toggle(): Promise<void> {
    const kind = this.uiState().kind
    if (kind === 'disconnected' || kind === 'mismatch' || kind === 'unauthorized' || kind === 'forbidden') {
      await this.connect()
      return
    }
    await this.setSharing(!readSettings().enabled)
  }

  private async setSharing(on: boolean): Promise<void> {
    if (!on) {
      const result = await this.serial(async () => (await this.controller?.setEnabled(false)) ?? 'nothing')
      this.warnIfNotCleared(result)
    }
    await vscode.workspace.getConfiguration('fudislte').update('presence.enabled', on, vscode.ConfigurationTarget.Global)
    await this.reload()
    if (!on) return
    // The click itself is activity.
    this.controller?.activity()
    if (this.context.globalState.get(EXPLAINED_KEY) === true) return
    await this.context.globalState.update(EXPLAINED_KEY, true)
    const settings = vscode.l10n.t('Settings')
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'While you work in VS Code, FUDISLTE shows you as Coding with the text "{0}". Nothing else is sent. The project and language are added only if you turn them on in Settings.',
        this.statusText(),
      ),
      settings,
    )
    if (choice === settings) await vscode.commands.executeCommand('workbench.action.openSettings', 'fudislte')
  }

  async shutdown(): Promise<void> {
    await this.controller?.stop('owned')
  }
}

let app: App | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('FUDISLTE Presence', { log: true })
  const item = vscode.window.createStatusBarItem('fudislte.presence', vscode.StatusBarAlignment.Right, 100)
  item.name = vscode.l10n.t('FUDISLTE Presence')
  const current = new App(context, log, item)
  app = current

  // Only events from the focused window count, so background changes (git, formatters,
  // other tools editing files) never keep someone "coding".
  const onActivity = (): void => {
    if (vscode.window.state.focused) current.activity()
  }
  context.subscriptions.push(
    log,
    current,
    vscode.commands.registerCommand('fudislte.connect', () => current.connect()),
    vscode.commands.registerCommand('fudislte.disconnect', () => current.disconnect()),
    vscode.commands.registerCommand('fudislte.togglePresence', () => current.toggle()),
    vscode.window.onDidChangeActiveTextEditor(onActivity),
    vscode.window.onDidChangeTextEditorSelection(onActivity),
    vscode.window.onDidChangeTextEditorVisibleRanges(onActivity),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document) onActivity()
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && state.active) current.activity()
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fudislte')) void current.reload()
    }),
    context.secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) void current.reload()
    }),
  )
  current.render()
  await current.reload()
}

export async function deactivate(): Promise<void> {
  await app?.shutdown()
  app = undefined
}
