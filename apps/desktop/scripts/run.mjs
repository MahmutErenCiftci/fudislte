// Starts Electron on the built app.
//   node scripts/run.mjs          → dev: loads FUDISLTE_DEV_SERVER_URL (default http://localhost:5173)
//   node scripts/run.mjs connect  → dev: starts on the "connect to server" screen
//   node scripts/run.mjs smoke    → loads the dev server, checks the sandbox and bridge, exits
//   node scripts/run.mjs picker   → opens the screen-share picker, picks the first source, exits
import { spawn } from 'node:child_process'

import electronPath from 'electron'

const mode = process.argv[2] ?? 'dev'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
if (mode !== 'connect' && mode !== 'picker') env.FUDISLTE_DEV_SERVER_URL ??= 'http://localhost:5173'
if (mode === 'smoke') env.FUDISLTE_SMOKE_TEST = '1'
if (mode === 'picker') env.FUDISLTE_SMOKE_TEST = 'picker'

const child = spawn(electronPath, ['.'], { stdio: ['ignore', 'pipe', 'inherit'], env })
let smokeLine = ''
child.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  process.stdout.write(text)
  smokeLine += text
})
child.on('exit', (code) => {
  if (mode === 'smoke' || mode === 'picker') {
    const ok = code === 0 && /FUDISLTE_(SMOKE|PICKER_SMOKE) /.test(smokeLine)
    console.log(ok ? 'smoke test passed' : `smoke test failed (exit ${code})`)
  }
  process.exit(code ?? 1)
})
