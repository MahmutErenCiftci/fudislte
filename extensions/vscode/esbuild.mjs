// Bundles the extension into dist/extension.js. `--production` (used by `vsce package`
// through vscode:prepublish) writes no source map; the code is left unminified so anyone
// can read exactly what the extension sends.
import { rm } from 'node:fs/promises'

import { build } from 'esbuild'

const production = process.argv.includes('--production')

await rm('dist', { recursive: true, force: true })
await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // VS Code 1.90 (the minimum in package.json) runs extensions on Node 20.
  target: 'node20',
  external: ['vscode'],
  sourcemap: production ? false : 'linked',
  // Development maps carry no copies of the sources.
  sourcesContent: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
})
console.log(`built dist/extension.js (${production ? 'production' : 'development'})`)
