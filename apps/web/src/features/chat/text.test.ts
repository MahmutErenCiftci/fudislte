import type { Message } from '@fudislte/api-client'
import { describe, expect, it } from 'vitest'

import { translate } from '../../i18n'
import { channelTitle } from './names'
import {
  arrangeMessages,
  fromMentionTokens,
  isNewer,
  mentionQuery,
  normalizeChannelName,
  parseMessage,
  plainText,
  toMentionTokens,
} from './text'

describe('mentions', () => {
  const ali = { id: '01a18d18-1543-7114-be95-212ecd091603', displayName: 'Ali' }
  const aliY = { id: '01a18d18-1557-7e42-823f-2d7df85b0ca3', displayName: 'Ali Yılmaz' }

  it('round-trips between tokens and names', () => {
    const body = `Selam <@${aliY.id}> ve <@${ali.id}>!`
    const { text, names } = fromMentionTokens(body, [ali, aliY])
    expect(text).toBe('Selam @Ali Yılmaz ve @Ali!')
    expect(toMentionTokens(text, names)).toBe(body)
  })

  it('renders tokens as mention parts and previews as names', () => {
    expect(parseMessage(`hey <@${ali.id}>`)).toEqual([
      { type: 'text', parts: [{ type: 'text', text: 'hey ' }, { type: 'mention', userId: ali.id }] },
    ])
    expect(plainText(`hey <@${ali.id}>\n\`\`\`ts\nx\n\`\`\``, [ali])).toBe('hey @Ali x')
  })

  it('finds the query being typed', () => {
    expect(mentionQuery('Selam @Al')).toEqual({ start: 6, query: 'Al' })
    expect(mentionQuery('@')).toEqual({ start: 0, query: '' })
    expect(mentionQuery('mail@example')).toBeNull()
    expect(mentionQuery('@Ali Y')).toBeNull()
  })
})

describe('channelTitle', () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('tr', key, vars)
  const p = (id: string) => ({ id, displayName: `Kişi ${id}` })
  const dm = (...ids: string[]) => ({ kind: 'direct' as const, name: '', participants: ids.map(p) })

  it('names conversations after the other people', () => {
    expect(channelTitle({ kind: 'channel', name: 'backend' }, 'me', t)).toBe('backend')
    expect(channelTitle(dm('me', 'a'), 'me', t)).toBe('Kişi a')
    expect(channelTitle(dm('a', 'b', 'me', 'c'), 'me', t)).toBe('Kişi a, Kişi b, Kişi c')
    expect(channelTitle(dm('a', 'b', 'c', 'd', 'me'), 'me', t)).toBe('Kişi a, Kişi b ve 2 kişi daha')
    expect(channelTitle(dm('me'), 'me', t)).toBe('Kişi me (sen)')
  })
})

describe('normalizeChannelName', () => {
  it('matches the API rule', () => {
    expect(normalizeChannelName('Müşteri Destek')).toBe('müşteri-destek')
    expect(normalizeChannelName('#Backend')).toBe('backend')
    expect(normalizeChannelName('İnsan Kaynakları')).toBe('insan-kaynakları')
    expect(normalizeChannelName('  a  --  b. c  ')).toBe('a-b-c')
    expect(normalizeChannelName('ürün_2!')).toBe('ürün_2')
  })
})

describe('parseMessage', () => {
  it('finds links, inline code and fenced code', () => {
    expect(parseMessage('Bak: https://fudislte.test/docs. Sonra `pnpm test`\n```ts\nconst a = 1\n```\nTamam')).toEqual([
      {
        type: 'text',
        parts: [
          { type: 'text', text: 'Bak: ' },
          { type: 'link', href: 'https://fudislte.test/docs', text: 'https://fudislte.test/docs' },
          { type: 'text', text: '. Sonra ' },
          { type: 'code', text: 'pnpm test' },
        ],
      },
      { type: 'code', language: 'ts', code: 'const a = 1' },
      { type: 'text', parts: [{ type: 'text', text: 'Tamam' }] },
    ])
  })

  it('never turns other schemes into links', () => {
    expect(parseMessage('javascript:alert(1) <b>x</b>')).toEqual([
      { type: 'text', parts: [{ type: 'text', text: 'javascript:alert(1) <b>x</b>' }] },
    ])
  })

  it('keeps an unclosed fence as text', () => {
    expect(parseMessage('```\nyarım')).toEqual([{ type: 'text', parts: [{ type: 'text', text: '```\nyarım' }] }])
  })
})

describe('arrangeMessages', () => {
  const msg = (id: string, author: string, createdAt: string): Message => ({
    id,
    channelId: 'c',
    author: { id: author, displayName: author },
    body: id,
    createdAt,
  })

  it('groups one author within five minutes and marks new days', () => {
    const rows = arrangeMessages([
      msg('1', 'a', '2026-10-29T10:00:00Z'),
      msg('2', 'a', '2026-10-29T10:03:00Z'),
      msg('3', 'b', '2026-10-29T10:04:00Z'),
      msg('4', 'b', '2026-10-29T10:20:00Z'),
      msg('5', 'b', '2026-10-30T10:21:00Z'),
    ])
    expect(rows.map((r) => [r.newDay, r.continued])).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [false, false],
      [true, false],
    ])
  })

  it('orders UUIDv7 IDs as strings', () => {
    expect(isNewer('01a18d18-2f57-777b-bb16-dbf397236b8c', '01a18d18-1543-7f24-a9a8-85223b555a2a')).toBe(true)
    expect(isNewer('01a18d18-1543-7f24-a9a8-85223b555a2a', null)).toBe(true)
  })
})
