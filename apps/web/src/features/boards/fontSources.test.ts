import { describe, expect, it } from 'vitest'

import { withoutCdnSources } from './fontSources'

const local = 'url(http://localhost:8088/excalidraw/fonts/Virgil/Virgil-Regular.woff2) format("woff2")'
const cdn = 'url(https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Virgil/Virgil-Regular.woff2) format("woff2")'

describe('whiteboard font sources', () => {
  it('drops the CDN fallback after the self-hosted font', () => {
    expect(withoutCdnSources(`${local}, ${cdn}`)).toBe(local)
    expect(withoutCdnSources(`${local},${cdn.replace(' format("woff2")', '')}`)).toBe(local)
  })

  it('leaves self-hosted and data sources alone', () => {
    expect(withoutCdnSources(local)).toBe(local)
    expect(withoutCdnSources('url(data:font/woff2;base64,AAAA)')).toBe('url(data:font/woff2;base64,AAAA)')
  })
})
