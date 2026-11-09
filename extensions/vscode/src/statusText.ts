// Builds the status text people see in FUDISLTE ("VS Code · fudislte-api · TypeScript") from
// opted-in fields only. Pure functions; test/statusText.test.ts covers the rules.
//
// Never part of the text: file names, paths, file contents, git data, counts of anything.
// A project name that looks like a path is dropped entirely rather than shortened, so
// "C:\Users\dana\secret" cannot leak "dana" or "secret".

export const STATUS_PREFIX = 'VS Code'
/** The API's limit, counted in Unicode code points (Go runes). */
export const MAX_STATUS_TEXT = 100
const MAX_PROJECT = 40
const MAX_LANGUAGE = 30
const SEPARATOR = ' · '

export interface StatusTextInput {
  shareProject: boolean
  shareLanguage: boolean
  /** Name of the workspace folder; the caller reads it only when shareProject is on. */
  projectName?: string | undefined
  /** VS Code language id of the active editor; read only when shareLanguage is on. */
  languageId?: string | undefined
}

export function buildStatusText(input: StatusTextInput): string {
  const parts = [STATUS_PREFIX]
  const project = input.shareProject ? sanitizeProjectName(input.projectName) : undefined
  if (project) parts.push(project)
  const language = input.shareLanguage ? languageLabel(input.languageId) : undefined
  if (language) parts.push(language)
  return truncate(parts.join(SEPARATOR), MAX_STATUS_TEXT)
}

/**
 * Removes invisible and control characters and collapses whitespace, so the API's own
 * normalization (whitespace and control characters collapsed to single spaces) leaves
 * the text unchanged and the extension can recognise the status it set.
 */
export function cleanText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\p{Cf}\p{Cs}\p{Co}]/gu, '')
    .replace(/[\p{Cc}\p{Z}]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .join(' ')
}

// Characters that separate path segments, including look-alikes that NFKC does not map.
const SEPARATORS = /[\\/\u2044\u2215\u29F5\u29F8\u29F9\uFE68\uFF0F\uFF3C]/u
// Drive letters, URL schemes (file:, vscode-remote:), scp-style host:path.
const COLONS = /[:\u2236\uFE13\uFE55\uFF1A]/u

/** True for anything that is, or is part of, a path, URL or user@host address. */
export function looksLikePath(s: string): boolean {
  const k = s.normalize('NFKC')
  return (
    SEPARATORS.test(k) ||
    COLONS.test(k) ||
    /%(?:2f|5c|3a)/i.test(k) ||
    k.includes('@') ||
    k.startsWith('~') ||
    k === '.' ||
    k === '..'
  )
}

/** The folder name to share, or undefined when there is none or it looks like a path. */
export function sanitizeProjectName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const s = cleanText(raw)
  if (!s || looksLikePath(s)) return undefined
  return truncate(s, MAX_PROJECT)
}

const LANGUAGE_NAMES = new Map<string, string>([
  ['bat', 'Batch'],
  ['c', 'C'],
  ['clojure', 'Clojure'],
  ['coffeescript', 'CoffeeScript'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['css', 'CSS'],
  ['dart', 'Dart'],
  ['dockerfile', 'Dockerfile'],
  ['elixir', 'Elixir'],
  ['erlang', 'Erlang'],
  ['fsharp', 'F#'],
  ['go', 'Go'],
  ['graphql', 'GraphQL'],
  ['groovy', 'Groovy'],
  ['haskell', 'Haskell'],
  ['html', 'HTML'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['javascriptreact', 'JavaScript JSX'],
  ['json', 'JSON'],
  ['jsonc', 'JSON'],
  ['julia', 'Julia'],
  ['kotlin', 'Kotlin'],
  ['latex', 'LaTeX'],
  ['less', 'Less'],
  ['lua', 'Lua'],
  ['makefile', 'Makefile'],
  ['markdown', 'Markdown'],
  ['objective-c', 'Objective-C'],
  ['objective-cpp', 'Objective-C++'],
  ['perl', 'Perl'],
  ['php', 'PHP'],
  ['plaintext', 'Plain Text'],
  ['powershell', 'PowerShell'],
  ['python', 'Python'],
  ['r', 'R'],
  ['razor', 'Razor'],
  ['ruby', 'Ruby'],
  ['rust', 'Rust'],
  ['scala', 'Scala'],
  ['scss', 'SCSS'],
  ['shellscript', 'Shell'],
  ['sql', 'SQL'],
  ['svelte', 'Svelte'],
  ['swift', 'Swift'],
  ['terraform', 'Terraform'],
  ['toml', 'TOML'],
  ['typescript', 'TypeScript'],
  ['typescriptreact', 'TypeScript JSX'],
  ['vb', 'Visual Basic'],
  ['vue', 'Vue'],
  ['xml', 'XML'],
  ['yaml', 'YAML'],
])

// Editors that are not code: commit messages and rebase plans are git data, the others
// are VS Code's own panels.
const HIDDEN_LANGUAGES = new Set(['git-commit', 'git-rebase', 'scminput', 'search-result', 'log', 'Log', 'code-text-binary'])

/** A display name for a VS Code language id, or undefined when it must not be shared. */
export function languageLabel(id: string | undefined): string | undefined {
  if (!id || HIDDEN_LANGUAGES.has(id) || id.startsWith('git-')) return undefined
  const known = LANGUAGE_NAMES.get(id)
  if (known) return known
  // Language ids are short identifiers; anything else is not passed on.
  if (!/^[A-Za-z0-9][A-Za-z0-9.+#_-]*$/.test(id) || id.length > MAX_LANGUAGE) return undefined
  return id
}

function truncate(s: string, max: number): string {
  const points = Array.from(s)
  if (points.length <= max) return s
  return `${points.slice(0, max - 1).join('').trimEnd()}…`
}
