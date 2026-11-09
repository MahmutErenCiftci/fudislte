import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MAX_STATUS_TEXT, buildStatusText, cleanText, languageLabel, looksLikePath, sanitizeProjectName } from '../src/statusText.ts'

const both = { shareProject: true, shareLanguage: true }

// What the API does to status text (presence.go): whitespace and control characters
// (Go's unicode.IsSpace / unicode.IsControl) collapse to single spaces.
function apiNormalize(text: string): string {
  return text
    .split(/[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\u0000-\u001F\u007F-\u009F]+/u)
    .filter(Boolean)
    .join(' ')
}

describe('buildStatusText', () => {
  it('is just "VS Code" unless fields are opted in', () => {
    assert.equal(buildStatusText({ shareProject: false, shareLanguage: false, projectName: 'fudislte-api', languageId: 'typescript' }), 'VS Code')
    assert.equal(buildStatusText({ ...both }), 'VS Code')
  })

  it('adds only the opted-in fields', () => {
    assert.equal(buildStatusText({ ...both, projectName: 'fudislte-api', languageId: 'typescript' }), 'VS Code · fudislte-api · TypeScript')
    assert.equal(buildStatusText({ shareProject: true, shareLanguage: false, projectName: 'fudislte-api', languageId: 'typescript' }), 'VS Code · fudislte-api')
    assert.equal(buildStatusText({ shareProject: false, shareLanguage: true, projectName: 'fudislte-api', languageId: 'go' }), 'VS Code · Go')
    assert.equal(buildStatusText({ ...both, projectName: 'Müşteri Destek', languageId: 'csharp' }), 'VS Code · Müşteri Destek · C#')
  })

  it('never leaks paths, even from workspace names that look like paths', () => {
    const pathLike = [
      'C:\\Users\\dana\\secret-project',
      '/home/dana/secret-project',
      'home/dana',
      '~/work/secret',
      '~',
      '~dana',
      '\\\\fileserver\\share\\secret',
      '\\\\?\\C:\\secret',
      'file:///C:/Users/dana/secret',
      'vscode-remote://wsl+Ubuntu/home/dana/secret',
      'C:',
      'D:secret',
      'C：／Users／dana',
      'secret∕project',
      'secret⁄project',
      'secret＼project',
      '%2Fhome%2Fdana',
      '%5CUsers%5Cdana',
      'dana@build-host',
      'git@github.com:corp/secret.git',
      'https://git.example.com/secret',
      '..',
      '.',
      'src/secret.ts',
      'secret\\file.go',
      '  /etc/passwd  ',
      'secret\u0000/x',
      '\u202E/terces',
    ]
    for (const name of pathLike) {
      assert.equal(looksLikePath(cleanText(name)) || cleanText(name) === '', true, name)
      const text = buildStatusText({ ...both, projectName: name, languageId: 'typescript' })
      assert.equal(text, 'VS Code · TypeScript', name)
    }
  })

  it('cleans names: whitespace, control and invisible characters', () => {
    assert.equal(sanitizeProjectName('  Müşteri   Destek\t'), 'Müşteri Destek')
    assert.equal(sanitizeProjectName('line\nbreak'), 'line break')
    assert.equal(sanitizeProjectName('abc\u202Edef\u200B'), 'abcdef')
    assert.equal(sanitizeProjectName('nbsp\u00A0name'), 'nbsp name')
    assert.equal(sanitizeProjectName(''), undefined)
    assert.equal(sanitizeProjectName('\u200B\u200F'), undefined)
    assert.equal(sanitizeProjectName(undefined), undefined)
    assert.equal(sanitizeProjectName('.dotfiles'), '.dotfiles')
  })

  it('shortens long names', () => {
    const long = sanitizeProjectName('x'.repeat(200))!
    assert.equal(Array.from(long).length, 40)
    assert.ok(long.endsWith('…'))
    const emoji = sanitizeProjectName('😀'.repeat(60))!
    assert.equal(Array.from(emoji).length, 40)
  })

  it('stays within the API limit and unchanged by the API normalization', () => {
    const projects = [undefined, 'fudislte-api', 'x'.repeat(500), '😀'.repeat(120), ' a \t b ', 'İstanbul Ofis', 'a\u3000b', 'x\u2028y']
    const languages = [undefined, 'typescript', 'x'.repeat(30), 'objective-cpp', 'plaintext']
    for (const projectName of projects) {
      for (const languageId of languages) {
        const text = buildStatusText({ ...both, projectName, languageId })
        assert.ok(Array.from(text).length <= MAX_STATUS_TEXT, text)
        assert.equal(apiNormalize(text), text, JSON.stringify(text))
        assert.ok(text.startsWith('VS Code'))
      }
    }
  })
})

describe('languageLabel', () => {
  it('names common languages', () => {
    assert.equal(languageLabel('typescript'), 'TypeScript')
    assert.equal(languageLabel('typescriptreact'), 'TypeScript JSX')
    assert.equal(languageLabel('go'), 'Go')
    assert.equal(languageLabel('csharp'), 'C#')
    assert.equal(languageLabel('cpp'), 'C++')
  })

  it('passes on other short language ids as they are', () => {
    assert.equal(languageLabel('zig'), 'zig')
    assert.equal(languageLabel('constructor'), 'constructor')
  })

  it('hides commit messages, panels and anything that is not a language id', () => {
    for (const id of ['git-commit', 'git-rebase', 'scminput', 'search-result', 'log', 'Log', undefined, '', 'C:\\Users\\dana', '/home/dana', 'a b', 'x'.repeat(31), '@scope/pkg']) {
      assert.equal(languageLabel(id), undefined, String(id))
    }
  })
})
