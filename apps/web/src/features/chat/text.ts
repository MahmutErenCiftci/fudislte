import type { Message } from '@fudislte/api-client'

/**
 * Mirrors the API's channel name rule (services/api/internal/chat): lower case, letters
 * of any language, digits, "-" and "_", separators collapse to "-". Used to preview the
 * name while typing; the API has the final word.
 */
export function normalizeChannelName(input: string): string {
  let s = input.trim().replace(/^#/, '').replaceAll('İ', 'i').toLowerCase()
  s = s.replace(/[\s.-]+/gu, '-').replace(/[^\p{L}\p{N}_-]/gu, '')
  return s.replace(/^-+|-+$/g, '').slice(0, 40)
}

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; text: string }
  | { type: 'mention'; userId: string }

export type Block = { type: 'text'; parts: Inline[] } | { type: 'code'; language: string; code: string }

const fence = /```([\w+#.-]*)[^\S\n]*\n?([\s\S]*?)```/g
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const inline = new RegExp(`\`([^\`\\n]+)\`|(https?:\\/\\/[^\\s<>"'\`]+)|<@(${uuid})>`, 'g')
const mentionToken = new RegExp(`<@(${uuid})>`, 'g')

/**
 * Splits message text into paragraphs and fenced code blocks, and paragraphs into text,
 * `inline code` and http(s) links. The result is rendered as React text — never HTML.
 */
export function parseMessage(body: string): Block[] {
  const blocks: Block[] = []
  let last = 0
  for (const m of body.matchAll(fence)) {
    pushText(blocks, body.slice(last, m.index))
    blocks.push({ type: 'code', language: m[1] ?? '', code: (m[2] ?? '').replace(/\n$/, '') })
    last = m.index + m[0].length
  }
  pushText(blocks, body.slice(last))
  return blocks
}

function pushText(blocks: Block[], text: string) {
  text = text.replace(/^\n+|\n+$/g, '')
  if (!text) return
  const parts: Inline[] = []
  let last = 0
  for (const m of text.matchAll(inline)) {
    let token = m[0]
    if (m[2]) {
      // Trailing punctuation usually ends the sentence, not the link.
      const trimmed = token.replace(/[.,;:!?]+$/, '')
      token = trimmed.endsWith(')') && !trimmed.includes('(') ? trimmed.slice(0, -1) : trimmed
    }
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) })
    parts.push(
      m[1] ? { type: 'code', text: m[1] } : m[3] ? { type: 'mention', userId: m[3] } : { type: 'link', href: token, text: token },
    )
    last = m.index + token.length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  blocks.push({ type: 'text', parts })
}

type Person = { id: string; displayName: string }

/** Message text for one-line previews: mentions become "@Name", code fences their code. */
export function plainText(body: string, mentions: Person[] = [], unknown = '@?'): string {
  return body
    .replace(mentionToken, (_, id: string) => {
      const person = mentions.find((p) => p.id === id)
      return person ? `@${person.displayName}` : unknown
    })
    .replace(/```[\w+#.-]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One line describing a message: its text, or its files when it has no text. */
export function messagePreview(m: Pick<Message, 'body' | 'mentions' | 'attachments'>): string {
  const text = plainText(m.body, m.mentions)
  if (text || !m.attachments?.length) return text
  return `📎 ${m.attachments.map((a) => a.name).join(', ')}`
}

/**
 * Text a person edits: <@id> tokens become "@Name". `names` maps each inserted name back
 * to its user so toMentionTokens can restore the tokens before sending.
 */
export function fromMentionTokens(body: string, mentions: Person[] = []): { text: string; names: Map<string, string> } {
  const names = new Map<string, string>()
  const text = body.replace(mentionToken, (token, id: string) => {
    const person = mentions.find((p) => p.id === id)
    if (!person) return token
    names.set(person.displayName, person.id)
    return `@${person.displayName}`
  })
  return { text, names }
}

/** Turns "@Name" back into <@id> for every name chosen from the mention list. */
export function toMentionTokens(text: string, names: Map<string, string>): string {
  // Longest names first, so "@Ali Yılmaz" is not taken for "@Ali".
  const sorted = [...names.entries()].sort(([a], [b]) => b.length - a.length)
  let out = text
  for (const [name, id] of sorted) out = out.split(`@${name}`).join(`<@${id}>`)
  return out
}

/** The "@query" being typed just before the caret, if any. */
export function mentionQuery(beforeCaret: string): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]{0,30})$/u.exec(beforeCaret)
  return m ? { start: m.index + m[1]!.length, query: m[2]! } : null
}

/** Message IDs are UUIDv7 strings: string order is time order. */
export function isNewer(a: string, b: string | null | undefined): boolean {
  return !b || a > b
}

const GROUP_WINDOW_MS = 5 * 60_000

export interface MessageRow {
  message: Message
  /** First message of a new day: show a date separator above it. */
  newDay: boolean
  /** Continues the previous message's run by the same author: no avatar or name. */
  continued: boolean
}

/** Adds day separators and groups consecutive messages by one author within 5 minutes. */
export function arrangeMessages(messages: Message[]): MessageRow[] {
  return messages.map((message, i) => {
    const prev = messages[i - 1]
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(message.createdAt).toDateString()
    const continued =
      !!prev &&
      !newDay &&
      !!message.author &&
      prev.author?.id === message.author.id &&
      new Date(message.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS
    return { message, newDay, continued }
  })
}
