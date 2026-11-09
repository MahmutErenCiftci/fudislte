import { describe, expect, it } from 'vitest'

import { setLanguage } from '../../i18n'
import { formatSize } from '../../lib/format'
import { fileIcon } from './Attachments'
import { searchWords } from './SearchPage'
import { messagePreview } from './text'

describe('files and search helpers', () => {
  it('describes file-only messages by their files', () => {
    const attachments = [
      { id: 'a', name: 'plan.pdf', contentType: 'application/pdf', size: 1, image: false, createdAt: '' },
      { id: 'b', name: 'ekran.png', contentType: 'image/png', size: 1, image: true, createdAt: '' },
    ]
    expect(messagePreview({ body: '', attachments })).toBe('📎 plan.pdf, ekran.png')
    expect(messagePreview({ body: 'Bak', attachments })).toBe('Bak')
  })

  it('formats sizes in the current language', () => {
    setLanguage('tr')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1,5 KB')
    expect(formatSize(25 * 1024 * 1024)).toBe('25 MB')
  })

  it('splits queries into words and picks icons by type', () => {
    expect(searchWords('kuber, "dün" & !')).toEqual(['kuber', 'dün'])
    expect(fileIcon('image/webp').displayName ?? fileIcon('image/webp').name).toBeTruthy()
    expect(fileIcon('application/pdf')).not.toBe(fileIcon('image/png'))
  })
})
