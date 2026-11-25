import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// In development the API runs on localhost:8080 (inside WSL on Windows). Proxying /api
// keeps the browser and the desktop shell on a single origin, exactly like production
// behind the reverse proxy.
const apiTarget = process.env.FUDISLTE_API_URL ?? 'http://127.0.0.1:8080'

export default defineConfig(({ mode }) =>
  mode === 'demo'
    ? {
        // The browser-only demo (src/demo): no server, the app answers its own API calls.
        plugins: [react(), tailwindcss(), excalidrawFonts(), demoEntry()],
        server: { port: 5175, strictPort: true },
        preview: { port: 4175 },
        build: { outDir: 'dist-demo' },
      }
    : {
        plugins: [react(), tailwindcss(), excalidrawFonts()],
        server: {
          port: 5173,
          strictPort: true,
          proxy: {
            '/api': { target: apiTarget, changeOrigin: false },
          },
        },
        preview: {
          port: 4173,
          proxy: {
            '/api': { target: apiTarget, changeOrigin: false },
          },
        },
      },
)

/**
 * Starts the demo build from src/demo/entry.ts, which installs the fake backend first, and
 * gives Cloudflare Pages the same security headers the server's Caddy sends
 * (infrastructure/docker/Caddyfile), minus camera and microphone, which the demo never uses.
 */
function demoEntry(): Plugin {
  const headers = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
  Strict-Transport-Security: max-age=31536000
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), display-capture=(), geolocation=(), payment=(), usb=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/excalidraw/*
  Cache-Control: public, max-age=31536000, immutable
`
  return {
    name: 'fudislte-demo-entry',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('/src/main.tsx', '/src/demo/entry.ts') },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: headers })
    },
  }
}

/**
 * Excalidraw's fonts, served by FUDISLTE itself instead of a public CDN: the dev server
 * answers /excalidraw/fonts/* from the installed package and the build copies them to
 * dist/excalidraw/fonts. The app points Excalidraw at /excalidraw/
 * (src/features/boards/excalidraw-assets.ts).
 *
 * Liberation Sans 1.05 (Excalidraw's legacy "Helvetica") is GPL-2.0 with a font
 * exception, so it is not shipped (docs/dependencies.md); drawings in that family fall
 * back to the viewer's own fonts.
 */
function excalidrawFonts(): Plugin {
  const fontsDir = path.resolve(import.meta.dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
  const prefix = '/excalidraw/fonts/'
  const shipped = (file: string) => !path.relative(fontsDir, file).split(path.sep).includes('Liberation')
  let outDir = ''
  return {
    name: 'fudislte-excalidraw-fonts',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? ''
        if (!url.startsWith(prefix)) return next()
        let file: string
        try {
          file = path.resolve(fontsDir, decodeURIComponent(url.slice(prefix.length)))
        } catch {
          return next()
        }
        if (!file.startsWith(fontsDir + path.sep) || !shipped(file) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', 'font/woff2')
        res.setHeader('Cache-Control', 'public, max-age=86400')
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      if (outDir && existsSync(fontsDir)) {
        cpSync(fontsDir, path.join(outDir, 'excalidraw', 'fonts'), { recursive: true, filter: shipped })
      }
    },
  }
}
