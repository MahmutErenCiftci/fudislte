// Lists a .vsix (a zip file) and fails when it contains anything that must not ship:
// source maps, sources, tests, scripts, node_modules, environment files, token-like
// strings or absolute paths of the build machine.
//
//   node scripts/check-vsix.mjs [file.vsix]     (default: newest *.vsix here)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

function newestVsix() {
  const files = readdirSync('.').filter((f) => f.endsWith('.vsix'))
  if (files.length === 0) throw new Error('no .vsix here; run npm run package first')
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

/** Reads every entry of a zip archive (stored or deflated) from its central directory. */
function readZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory')
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)
    p += 46 + nameLength + extraLength + commentLength
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + compressed)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (!data || data.length !== size) throw new Error(`cannot read ${name}`)
    entries.push({ name, size, data })
  }
  return entries
}

const file = process.argv[2] ?? newestVsix()
const entries = readZip(readFileSync(file))
const problems = []

console.log(`${file}: ${entries.length} entries`)
for (const e of entries) console.log(`  ${String(e.size).padStart(8)}  ${e.name}`)

const required = [
  'extension.vsixmanifest',
  '[Content_Types].xml',
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/package.nls.json',
  'extension/package.nls.tr.json',
  'extension/l10n/bundle.l10n.tr.json',
]
for (const name of required) if (!entries.some((e) => e.name === name)) problems.push(`missing ${name}`)

const forbiddenNames = [
  [/\.map$/i, 'source map'],
  [/\.(ts|mts|cts)$/i, 'TypeScript source'],
  [/(^|\/)(src|test|tests|scripts|node_modules|\.vscode)\//, 'sources, tests, scripts or dependencies'],
  [/(^|\/)\.env/i, 'environment file'],
  [/\.(vsix|log|pem|key|p12|pfx)$/i, 'archive, log or key file'],
  [/(^|\/)(tsconfig\.json|esbuild\.mjs|package-lock\.json|\.npmrc)$/, 'build file'],
]
for (const e of entries) {
  for (const [pattern, what] of forbiddenNames) if (pattern.test(e.name)) problems.push(`${e.name}: ${what}`)
}

const forbiddenContent = [
  [/sourceMappingURL/, 'source map reference'],
  [/fdp_[A-Za-z0-9_-]{20,}/, 'token-like string'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(ghp|gho|github_pat|glpat|xox[abp])[-_][A-Za-z0-9_-]{16,}/, 'third-party token'],
  [/\b[A-Za-z]:\\\\?(Users|Documents and Settings|Program Files)/i, 'Windows absolute path'],
  [/(^|[\s"'(=])\/(Users|home|root)\/[^\s"')]+/, 'Unix home path'],
  [/OneDrive|AppData/i, 'build machine path'],
]
for (const e of entries) {
  if (!/\.(js|map|json|md|xml|vsixmanifest|txt)$/i.test(e.name)) continue
  const text = e.data.toString('utf8')
  for (const [pattern, what] of forbiddenContent) if (pattern.test(text)) problems.push(`${e.name}: ${what}`)
}

if (problems.length > 0) {
  console.error(`\nFAILED (${problems.length}):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\nOK: no source maps, sources, tests, secrets or absolute paths.')
