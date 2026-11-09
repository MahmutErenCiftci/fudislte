// Prints the third-party notices for the npm packages that a workspace package ships:
// every production dependency, direct and transitive, with the license and notice files
// it carries. MIT, BSD, ISC, Apache-2.0 and OFL all require these texts to travel with
// redistributed code (docs/dependencies.md).
//
//   node scripts/licenses/notices.mjs --filter "@fudislte/web..." --title "the FUDISLTE web app" > licenses.txt
//
// FUDISLTE's own workspace packages are left out: they are covered by LICENSE and NOTICE.
import { execFileSync, execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

function option(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const filter = option('--filter')
const title = option('--title') ?? filter
if (!filter) {
  console.error('usage: node scripts/licenses/notices.mjs --filter <pnpm selector> [--title <text>]')
  process.exit(2)
}

const args = ['--filter', filter, 'licenses', 'list', '--prod', '--json']
const run = { encoding: 'utf8', maxBuffer: 64 << 20 }
// On Windows pnpm is a .cmd script, which only starts through a shell.
const listing =
  process.platform === 'win32' ? execSync(`pnpm ${args.map((a) => `"${a}"`).join(' ')}`, run) : execFileSync('pnpm', args, run)

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i
const RULE = '='.repeat(78)

const packages = new Map()
for (const group of Object.values(JSON.parse(listing))) {
  for (const p of group) {
    if (p.name.startsWith('@fudislte/')) continue
    for (const dir of p.paths) {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
      const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
      packages.set(`${p.name}@${manifest.version}`, {
        name: p.name,
        version: manifest.version,
        license: p.license,
        homepage: p.homepage,
        author,
        repository,
        dir,
      })
    }
  }
}

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const missing = []
let out = `Third-party software included in ${title}

FUDISLTE itself is licensed under the PolyForm Internal Use License 1.0.0 (LICENSE, NOTICE). It includes
the ${sorted.length} packages below, each under its own license. Where a package offers a choice
of licenses, FUDISLTE uses it under the permissive one.
`
for (const p of sorted) {
  const files = readdirSync(p.dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
  out += `\n${RULE}\n${p.name}@${p.version} (${p.license})${p.homepage ? `\n${p.homepage}` : ''}\n${RULE}\n`
  if (files.length === 0) {
    missing.push(`${p.name}@${p.version}`)
    out += `The package carries no license file. Its package.json declares ${p.license}`
    out += `${p.author ? `, author ${p.author}` : ''}${p.repository ? `, source ${p.repository}` : ''}.\n`
    out += `The license texts are at https://spdx.org/licenses/.\n`
  }
  for (const f of files) out += `\n${readFileSync(path.join(p.dir, f), 'utf8').trim()}\n`
}

process.stdout.write(out)
console.error(`notices: ${sorted.length} packages${missing.length ? `; without a license file: ${missing.join(', ')}` : ''}`)
