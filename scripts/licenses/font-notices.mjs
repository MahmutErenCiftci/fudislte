// Prints the copyright and license notices of the web fonts in a directory, read from each
// font's own name table, followed by the license texts they refer to. The web build
// serves Excalidraw's fonts from dist/excalidraw/fonts; the SIL Open Font License requires
// the copyright notices and the license to travel with the fonts.
//
//   node scripts/licenses/font-notices.mjs <fonts dir> <OFL-1.1 license file>
//
// The OFL file is any file that contains the full license text, such as the LICENSE of
// @fontsource-variable/inter. A font whose license is neither OFL nor MIT fails the run.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

// WOFF2 "known table tags", in the order of their index (WOFF2 specification, 5.1).
const KNOWN_TAGS =
  'cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill'
    .split(' ')
    .map((t) => t.replace('_', ' '))

// Families whose files state no license: the license their authors publish.
const PUBLISHED = {
  Excalifont: { license: 'SIL Open Font License 1.1, as published by Excalidraw', url: 'https://plus.excalidraw.com/excalifont' },
  Xiaolai: { license: 'SIL Open Font License 1.1, as published by its author', url: 'https://github.com/lxgw/kose-font' },
}

const [fontsDir, oflFile] = process.argv.slice(2)
if (!fontsDir || !oflFile) {
  console.error('usage: node scripts/licenses/font-notices.mjs <fonts dir> <OFL-1.1 license file>')
  process.exit(2)
}

function base128(buf, pos) {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos.at++]
    value = value * 128 + (byte & 0x7f)
    if (!(byte & 0x80)) return value
  }
  throw new Error('bad UIntBase128')
}

/** The name table of a WOFF2 font. WOFF2 never transforms it, so it is stored as is. */
function nameTable(file) {
  const buf = readFileSync(file)
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error(`${file}: not a WOFF2 font`)
  if (buf.toString('latin1', 4, 8) === 'ttcf') throw new Error(`${file}: font collections are not supported`)
  const numTables = buf.readUInt16BE(12)
  const compressedSize = buf.readUInt32BE(20)
  const pos = { at: 48 }
  let offset = 0
  let name
  for (let t = 0; t < numTables; t++) {
    const flags = buf[pos.at++]
    const tag = (flags & 0x3f) === 63 ? buf.toString('latin1', pos.at, (pos.at += 4)) : KNOWN_TAGS[flags & 0x3f]
    const version = flags >> 6
    const origLength = base128(buf, pos)
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0
    const length = transformed ? base128(buf, pos) : origLength
    if (tag === 'name') name = { offset, length }
    offset += length
  }
  if (!name) throw new Error(`${file}: no name table`)
  const tables = brotliDecompressSync(buf.subarray(pos.at, pos.at + compressedSize))
  return tables.subarray(name.offset, name.offset + name.length)
}

/** Copyright (name ID 0), license description (13) and license URL (14). */
function notices(table) {
  const count = table.readUInt16BE(2)
  const storage = table.readUInt16BE(4)
  const best = {}
  for (let r = 0; r < count; r++) {
    const p = 6 + r * 12
    const [platform, encoding, language, id, length, at] = [0, 2, 4, 6, 8, 10].map((o) => table.readUInt16BE(p + o))
    if (![0, 13, 14].includes(id)) continue
    const raw = Buffer.from(table.subarray(storage + at, storage + at + length))
    let text
    if (platform === 0 || platform === 3) text = raw.swap16().toString('utf16le')
    else if (platform === 1 && encoding === 0) text = raw.toString('latin1')
    else continue
    // Prefer the Windows US English record.
    const rank = platform === 3 && language === 0x409 ? 2 : 1
    if (!best[id] || best[id].rank < rank) best[id] = { rank, text: text.trim() }
  }
  return { copyright: best[0]?.text ?? '', license: best[13]?.text ?? '', url: best[14]?.text ?? '' }
}

const files = readdirSync(fontsDir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.woff2'))
  .sort()
const families = new Map()
for (const f of files) {
  const family = f.split(/[\\/]/)[0]
  const n = notices(nameTable(path.join(fontsDir, f)))
  const entry = families.get(family) ?? { files: 0, notices: new Map() }
  entry.files++
  entry.notices.set(`${n.copyright}\n${n.license}\n${n.url}`, n)
  families.set(family, entry)
}

const kinds = new Set()
const RULE = '='.repeat(78)
let out = `\n${RULE}\nFonts served with the whiteboard (from @excalidraw/excalidraw), as their files declare\n${RULE}\n`
for (const [family, { files: count, notices: list }] of families) {
  out += `\n${family} (${count} files)\n`
  for (const n of list.values()) {
    if (!n.license && !n.url && PUBLISHED[family]) Object.assign(n, PUBLISHED[family])
    // Some fonts put the whole license in the copyright record (Comic Shanns: MIT).
    const all = `${n.copyright} ${n.license} ${n.url}`
    const kind = /open font license|scripts\.sil\.org\/OFL|openfontlicense\.org/i.test(all)
      ? 'OFL-1.1'
      : /\bMIT License\b/.test(all)
        ? 'MIT'
        : null
    if (!kind) throw new Error(`${family}: license not recognised: ${n.license || n.url || '(none)'}`)
    kinds.add(kind)
    out += `  ${n.copyright || '(no copyright notice in the font)'}\n  ${n.license}${n.url ? `\n  ${n.url}` : ''}\n`
  }
}

if (kinds.has('OFL-1.1')) {
  const ofl = readFileSync(oflFile, 'utf8')
  const start = ofl.indexOf('SIL OPEN FONT LICENSE Version 1.1')
  if (start < 0) throw new Error(`${oflFile}: no SIL Open Font License 1.1 text`)
  out += `\n-- SIL Open Font License 1.1 --\n\n${ofl.slice(start).trim()}\n`
}
if (kinds.has('MIT')) {
  const mit = readFileSync(new URL('../../LICENSES/MIT.txt', import.meta.url), 'utf8')
  out += `\n-- MIT License (copyright notices above) --\n\n${mit.replace(/^Copyright.*\n\n/m, '').trim()}\n`
}
process.stdout.write(out)
console.error(`font-notices: ${files.length} fonts in ${families.size} families (${[...kinds].join(', ')})`)
