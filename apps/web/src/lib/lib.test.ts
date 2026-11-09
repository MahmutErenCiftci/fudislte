import type { Member, Role } from '@fudislte/api-client'
import { describe, expect, it } from 'vitest'

import { setLanguage } from '../i18n'

import { describeUserAgent } from './format'
import { groupMembersByRole } from './members'
import { canAssign, outranks } from './permissions'
import { safeNext } from './session'

const role = (key: string, name: string, position: number) => ({ id: key, key, name, position })
const member = (name: string, r: ReturnType<typeof role>): Member => ({
  user: { id: name, displayName: name, email: `${name}@example.com` },
  role: r,
  disabled: false,
  joinedAt: '2026-01-01T00:00:00Z',
})

describe('groupMembersByRole', () => {
  it('orders groups by rank and members by name', () => {
    const owner = role('owner', 'Owner', 100)
    const dev = role('developer', 'Developer', 30)
    const admin = role('administrator', 'Administrator', 90)
    const groups = groupMembersByRole([
      member('Robert', dev),
      member('alex', owner),
      member('David', dev),
      member('Sarah', admin),
    ])
    expect(groups.map((g) => [g.role.name, g.members.map((m) => m.user.displayName)])).toEqual([
      ['Owner', ['alex']],
      ['Administrator', ['Sarah']],
      ['Developer', ['David', 'Robert']],
    ])
  })
})

describe('role hierarchy helpers', () => {
  const owner = { key: 'owner', position: 100 } as Role
  const admin = { key: 'administrator', position: 90 } as Role

  it('mirrors the API rules', () => {
    expect(outranks(admin, 30)).toBe(true)
    expect(outranks(admin, 90)).toBe(false)
    expect(outranks(owner, 100)).toBe(true)
    expect(canAssign(admin, role('owner', 'Owner', 100))).toBe(false)
    expect(canAssign(admin, role('administrator', 'Administrator', 90))).toBe(false)
    expect(canAssign(admin, role('developer', 'Developer', 30))).toBe(true)
    expect(canAssign(owner, role('owner', 'Owner', 100))).toBe(true)
  })
})

describe('safeNext', () => {
  it('only allows same-site relative paths', () => {
    expect(safeNext('/w/acme/settings')).toBe('/w/acme/settings')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
    expect(safeNext(null)).toBe('/')
  })
})

describe('describeUserAgent', () => {
  it('recognises common clients', () => {
    setLanguage('en')
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')).toBe(
      'Chrome on Windows',
    )
    expect(describeUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit Chrome/140.0 Electron/45.1.0 FudislteDesktop/0.1.0')).toBe(
      'FUDISLTE Desktop on macOS',
    )
    expect(describeUserAgent('')).toBe('Unknown device')
    setLanguage('tr')
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0')).toBe('Chrome · Windows')
    expect(describeUserAgent('')).toBe('Bilinmeyen cihaz')
  })
})
