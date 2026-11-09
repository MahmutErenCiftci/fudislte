// Excalidraw loads its fonts from window.EXCALIDRAW_ASSET_PATH, falling back to a public
// CDN. FUDISLTE is self-hosted: the fonts are served by the app itself (vite.config.ts
// copies them into the build). Imported before Excalidraw so the path is set first.

import { withoutCdnSources } from './fontSources'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'

// Excalidraw lists the CDN as every font's second source. The CSP blocks it, but browsers
// report each blocked source as soon as the font is registered (hundreds per board), and
// without a CSP a missing font would be fetched from the CDN. So the browser never sees it.
const NativeFontFace = window.FontFace
window.FontFace = class extends NativeFontFace {
  constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    super(family, typeof source === 'string' ? withoutCdnSources(source) : source, descriptors)
  }
}
