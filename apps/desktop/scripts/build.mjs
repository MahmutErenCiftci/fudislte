// Bundles the main process, the sandboxed preload (which must be a single file) and the
// connect page into dist/.
import { cp, mkdir, rm } from 'node:fs/promises'

import { build } from 'esbuild'

const common = { bundle: true, logLevel: 'warning', sourcemap: 'linked' }

await rm('dist', { recursive: true, force: true })
await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', target: 'chrome130', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/connect.ts'], outfile: 'dist/renderer/connect.js', platform: 'browser', format: 'iife', target: 'chrome130' }),
])
await mkdir('dist/renderer', { recursive: true })
await cp('src/renderer/connect.html', 'dist/renderer/connect.html')
await cp('src/renderer/connect.css', 'dist/renderer/connect.css')
console.log('desktop build complete')
