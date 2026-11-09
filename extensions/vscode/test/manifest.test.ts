// package.json contributions and the English/Turkish strings stay in step.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

interface Setting {
  default: unknown
  scope?: string
}

const pkg = JSON.parse(read('package.json')) as {
  main: string
  activationEvents: string[]
  contributes: { commands: { command: string }[]; configuration: { properties: Record<string, Setting> } }
}
const nls = JSON.parse(read('package.nls.json')) as Record<string, string>
const nlsTr = JSON.parse(read('package.nls.tr.json')) as Record<string, string>
const bundleTr = JSON.parse(read('l10n/bundle.l10n.tr.json')) as Record<string, string>

const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort()

describe('manifest', () => {
  it('has an English and a Turkish text for every manifest string', () => {
    const used = [...new Set((JSON.stringify(pkg).match(/%[\w.]+%/g) ?? []).map((s) => s.slice(1, -1)))].sort()
    assert.ok(used.length >= 10)
    assert.deepEqual(Object.keys(nls).sort(), used)
    assert.deepEqual(Object.keys(nlsTr).sort(), used)
    for (const key of used) {
      assert.ok(nls[key]?.trim(), key)
      assert.ok(nlsTr[key]?.trim(), key)
      assert.notEqual(nlsTr[key], nls[key], `${key} is not translated`)
    }
  })

  it('has a Turkish translation for every runtime string', () => {
    const dir = new URL('../src/', import.meta.url)
    const source = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(new URL(f, dir), 'utf8'))
      .join('\n')
    const literal = [...source.matchAll(/l10n\.t\(\s*(['"])((?:(?!\1).)*)\1/gs)].map((m) => m[2]!)
    assert.equal(literal.length, (source.match(/l10n\.t\(/g) ?? []).length, 'every l10n.t() call takes a string literal')
    const used = [...new Set(literal)].sort()
    assert.deepEqual(Object.keys(bundleTr).sort(), used)
    for (const [en, tr] of Object.entries(bundleTr)) {
      assert.ok(tr.trim(), en)
      assert.deepEqual(placeholders(tr), placeholders(en), en)
    }
  })

  it('keeps sharing off by default and reads every setting from user settings only', () => {
    const props = pkg.contributes.configuration.properties
    assert.equal(props['fudislte.presence.enabled']?.default, false)
    assert.equal(props['fudislte.presence.shareProject']?.default, false)
    assert.equal(props['fudislte.presence.shareLanguage']?.default, false)
    assert.equal(props['fudislte.presence.idleMinutes']?.default, 10)
    assert.equal(props['fudislte.serverUrl']?.default, '')
    for (const [key, setting] of Object.entries(props)) assert.equal(setting.scope, 'application', key)
  })

  it('contributes the three commands and runs the bundled file', () => {
    assert.deepEqual(pkg.contributes.commands.map((c) => c.command).sort(), ['fudislte.connect', 'fudislte.disconnect', 'fudislte.togglePresence'])
    assert.deepEqual(pkg.activationEvents, ['onStartupFinished'])
    assert.equal(pkg.main, './dist/extension.js')
  })
})
