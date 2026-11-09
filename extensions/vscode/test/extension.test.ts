// Runs the bundled extension (built from src/extension.ts with esbuild, as for the .vsix)
// against a fake of the VS Code API and a local FUDISLTE stand-in. This checks the wiring
// (commands, settings, SecretStorage, status bar, editor events); it is not VS Code
// itself, whose behaviour the fake only models.

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { TOKEN, fakeFudislte, listen, waitFor } from './helpers.ts'

type Listener<T> = (e: T) => void

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>()
  readonly event = (listener: Listener<T>) => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(e: T): void {
    for (const l of [...this.listeners]) l(e)
  }
}

function fakeVscode() {
  const settings = new Map<string, unknown>()
  const configChanged = new Emitter<{ affectsConfiguration(section: string): boolean }>()
  const editor = {
    active: new Emitter<unknown>(),
    selection: new Emitter<unknown>(),
    ranges: new Emitter<unknown>(),
    document: new Emitter<{ document: unknown; contentChanges: unknown[] }>(),
    window: new Emitter<{ focused: boolean; active: boolean }>(),
  }
  const commands = new Map<string, (...args: unknown[]) => unknown>()
  const shown: { kind: string; message: string }[] = []
  /** Answers for input boxes and message buttons, in the order they are asked. */
  const answers: (string | undefined)[] = []
  const item = {
    text: '',
    tooltip: '' as unknown,
    command: '' as unknown,
    backgroundColor: undefined as unknown,
    name: '',
    accessibilityInformation: undefined as unknown,
    show() {},
    dispose() {},
  }
  const document = { uri: { scheme: 'file' }, languageId: 'typescript' }
  const message =
    (kind: string) =>
    async (text: string, ...buttons: string[]) => {
      shown.push({ kind, message: text })
      return buttons.length > 0 ? answers.shift() : undefined
    }
  const vscode = {
    l10n: { t: (m: string, ...args: unknown[]) => m.replace(/\{(\d+)\}/g, (_: string, i: string) => String(args[Number(i)])) },
    env: { language: 'en' },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    ThemeColor: class ThemeColor {
      id: string
      constructor(id: string) {
        this.id = id
      }
    },
    window: {
      state: { focused: true, active: true },
      activeTextEditor: { document },
      createOutputChannel: () => ({ info() {}, warn() {}, error() {}, dispose() {} }),
      createStatusBarItem: () => item,
      showInputBox: async (o: { validateInput?: (v: string) => string | undefined }) => {
        const v = answers.shift()
        const problem = v === undefined ? undefined : o.validateInput?.(v)
        if (problem) throw new Error(`input ${v} rejected: ${problem}`)
        return v
      },
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      withProgress: (_o: unknown, task: () => Promise<unknown>) => task(),
      onDidChangeWindowState: editor.window.event,
      onDidChangeActiveTextEditor: editor.active.event,
      onDidChangeTextEditorSelection: editor.selection.event,
      onDidChangeTextEditorVisibleRanges: editor.ranges.event,
    },
    workspace: {
      workspaceFolders: [{ name: 'fudislte-api' }],
      getWorkspaceFolder: () => ({ name: 'fudislte-api' }),
      getConfiguration: (section: string) => ({
        get: (key: string, fallback: unknown) => (settings.has(`${section}.${key}`) ? settings.get(`${section}.${key}`) : fallback),
        update: async (key: string, value: unknown) => {
          const full = `${section}.${key}`
          settings.set(full, value)
          configChanged.fire({ affectsConfiguration: (s: string) => full === s || full.startsWith(`${s}.`) })
        },
      }),
      onDidChangeConfiguration: configChanged.event,
      onDidChangeTextDocument: editor.document.event,
    },
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
        commands.set(id, fn)
        return { dispose() {} }
      },
      executeCommand: async (id: string, ...args: unknown[]) => commands.get(id)?.(...args),
    },
  }
  return { vscode, settings, commands, shown, answers, item, editor, document }
}

function fakeContext() {
  const secrets = new Map<string, string>()
  const secretChanged = new Emitter<{ key: string }>()
  const state = new Map<string, unknown>()
  const context = {
    subscriptions: [] as { dispose(): void }[],
    extension: { packageJSON: { version: '0.1.0' } },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value)
        secretChanged.fire({ key })
      },
      delete: async (key: string) => {
        secrets.delete(key)
        secretChanged.fire({ key })
      },
      onDidChange: secretChanged.event,
    },
    globalState: {
      get: (key: string) => state.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) state.delete(key)
        else state.set(key, structuredClone(value))
      },
    },
  }
  return { context, secrets, state }
}

interface Extension {
  activate(context: unknown): Promise<void>
  deactivate(): Promise<void>
}

async function loadExtension(vscode: unknown): Promise<Extension> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/extension.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0]!.text
  const nodeRequire = createRequire(import.meta.url)
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', code)((id: string) => (id === 'vscode' ? vscode : nodeRequire(id)), module, module.exports)
  return module.exports as unknown as Extension
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('extension wiring (fake VS Code API, local FUDISLTE)', () => {
  it('connects, shares only opted-in fields, turns sharing off and disconnects', async () => {
    const fudislte = fakeFudislte()
    const server = await listen(fudislte.handler)
    const fake = fakeVscode()
    const { context, secrets } = fakeContext()
    const ext = await loadExtension(fake.vscode)
    const requests = () => server.seen.map((r) => `${r.method} ${r.url}`)
    try {
      await ext.activate(context)
      assert.equal(fake.item.text, '$(plug) FUDISLTE')
      assert.equal(fake.item.command, 'fudislte.connect')
      assert.deepEqual([...fake.commands.keys()].sort(), ['fudislte.connect', 'fudislte.disconnect', 'fudislte.togglePresence'])
      fake.editor.selection.fire({})
      await sleep(50)
      assert.equal(server.seen.length, 0, 'nothing is sent before connecting')

      // Connect: address, token, then "Share while I work"; the explanation is dismissed.
      fake.answers.push(server.origin, TOKEN, 'Share while I work', undefined)
      await fake.commands.get('fudislte.connect')!()
      await waitFor(() => fake.item.text === '$(broadcast) FUDISLTE', 'sharing')
      assert.equal(fake.settings.get('fudislte.serverUrl'), server.origin)
      assert.equal(fake.settings.get('fudislte.presence.enabled'), true)
      assert.deepEqual(JSON.parse(secrets.get('fudislte.connection')!), { origin: server.origin, token: TOKEN })
      assert.deepEqual(requests(), ['GET /api/v1/meta', 'GET /api/v1/me', 'GET /api/v1/me', 'PUT /api/v1/me/status'])
      assert.equal(server.seen[0]!.headers.authorization, undefined, 'the server check carries no token')
      assert.equal(fudislte.state.status?.text, 'VS Code', 'project and language stay private until opted in')
      assert.ok(fake.shown.some((m) => m.message.includes('"VS Code"') && m.message.includes('Nothing else is sent')))

      // Opting in to the project name updates the text at once.
      await fake.vscode.workspace.getConfiguration('fudislte').update('presence.shareProject', true)
      await waitFor(() => fudislte.state.status?.text === 'VS Code · fudislte-api', 'project name in the text')

      // Editor activity within the refresh interval sends nothing more.
      const count = server.seen.length
      for (let i = 0; i < 20; i++) fake.editor.selection.fire({})
      fake.editor.document.fire({ document: fake.document, contentChanges: [{}] })
      fake.editor.window.fire({ focused: true, active: true })
      await sleep(100)
      assert.equal(server.seen.length, count)

      // The status bar item turns sharing off, which clears the status at once.
      assert.equal(fake.item.command, 'fudislte.togglePresence')
      await fake.commands.get('fudislte.togglePresence')!()
      await waitFor(() => fake.item.text === '$(circle-slash) FUDISLTE', 'sharing off')
      assert.equal(fudislte.state.status, null)
      assert.equal(fake.settings.get('fudislte.presence.enabled'), false)

      await fake.commands.get('fudislte.disconnect')!()
      await waitFor(() => fake.item.text === '$(plug) FUDISLTE', 'disconnected')
      assert.equal(secrets.has('fudislte.connection'), false)
      assert.ok(fake.shown.some((m) => m.message.startsWith('Disconnected from FUDISLTE')))

      // The language was never opted in, and nothing path-like was ever sent.
      for (const r of server.seen) assert.ok(!/typescript|\\|Users|home/i.test(r.body), r.body)
    } finally {
      await ext.deactivate()
      await server.close()
    }
  })

  it('asks to reconnect when the token is rejected, and stops sending', async () => {
    const fudislte = fakeFudislte()
    const server = await listen(fudislte.handler)
    const fake = fakeVscode()
    const { context, secrets } = fakeContext()
    fake.settings.set('fudislte.serverUrl', server.origin)
    fake.settings.set('fudislte.presence.enabled', true)
    secrets.set('fudislte.connection', JSON.stringify({ origin: server.origin, token: TOKEN }))
    const ext = await loadExtension(fake.vscode)
    try {
      await ext.activate(context)
      assert.equal(fake.item.text, '$(debug-pause) FUDISLTE', 'connected and idle until there is activity')
      fudislte.state.token = `fdp_${'r'.repeat(43)}` // the token was revoked
      fake.editor.selection.fire({})
      await waitFor(() => fake.item.text === '$(error) FUDISLTE', 'unauthorized')
      assert.equal(fake.item.command, 'fudislte.connect')
      assert.equal(fake.shown.filter((m) => m.kind === 'warning' && m.message.startsWith('FUDISLTE rejected the access token')).length, 1)
      const count = server.seen.length
      for (let i = 0; i < 10; i++) fake.editor.selection.fire({})
      await sleep(100)
      assert.equal(server.seen.length, count, 'a rejected token is not used again')
    } finally {
      await ext.deactivate()
      await server.close()
    }
  })

  it('never sends the token to an address it was not entered for', async () => {
    const fudislte = fakeFudislte()
    const server = await listen(fudislte.handler)
    const other = await listen(fakeFudislte().handler)
    const fake = fakeVscode()
    const { context, secrets } = fakeContext()
    fake.settings.set('fudislte.serverUrl', server.origin)
    fake.settings.set('fudislte.presence.enabled', true)
    secrets.set('fudislte.connection', JSON.stringify({ origin: server.origin, token: TOKEN }))
    const ext = await loadExtension(fake.vscode)
    try {
      await ext.activate(context)
      fake.editor.selection.fire({})
      await waitFor(() => fudislte.state.status?.text === 'VS Code', 'status set')

      // Settings now point elsewhere (as a synced or edited setting could).
      await fake.vscode.workspace.getConfiguration('fudislte').update('serverUrl', other.origin)
      await waitFor(() => fake.item.text === '$(warning) FUDISLTE', 'address mismatch')
      assert.equal(fudislte.state.status, null, 'the status on the first server was cleared on the way out')
      fake.editor.selection.fire({})
      await sleep(100)
      assert.equal(other.seen.length, 0)
    } finally {
      await ext.deactivate()
      await server.close()
      await other.close()
    }
  })

  it('clears the status when VS Code closes', async () => {
    const fudislte = fakeFudislte()
    const server = await listen(fudislte.handler)
    const fake = fakeVscode()
    const { context, secrets } = fakeContext()
    fake.settings.set('fudislte.serverUrl', server.origin)
    fake.settings.set('fudislte.presence.enabled', true)
    secrets.set('fudislte.connection', JSON.stringify({ origin: server.origin, token: TOKEN }))
    const ext = await loadExtension(fake.vscode)
    try {
      await ext.activate(context)
      fake.editor.active.fire({})
      await waitFor(() => fudislte.state.status !== null, 'status set')
      await ext.deactivate()
      assert.equal(fudislte.state.status, null)
      assert.deepEqual(
        server.seen.map((r) => `${r.method} ${r.url}`).slice(-2),
        ['GET /api/v1/me', 'DELETE /api/v1/me/status'],
      )
    } finally {
      await server.close()
    }
  })
})
