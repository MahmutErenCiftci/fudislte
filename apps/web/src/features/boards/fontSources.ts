/** Excalidraw's fallback font sources on the esm.sh CDN, after the self-hosted one. */
const CDN_SOURCE = /\s*,\s*url\(\s*["']?https:\/\/esm\.sh\/[^)]*\)(\s*format\([^)]*\))?/g

/** A FontFace source list without the CDN fallbacks. */
export function withoutCdnSources(source: string): string {
  return source.replace(CDN_SOURCE, '')
}
