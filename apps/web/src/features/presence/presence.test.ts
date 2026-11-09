import { describe, expect, it } from 'vitest'

import { translate } from '../../i18n'
import { liveStatus, presenceDot, presenceLine } from './presence'

const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('tr', key, vars)

describe('presence', () => {
  const meeting = { kind: 'meeting' as const, text: 'Sprint planlama' }

  it('colors the dot by state and status', () => {
    expect(presenceDot('offline', meeting, t)).toBeUndefined()
    expect(presenceDot('away', meeting, t)?.label).toBe('Uzakta')
    expect(presenceDot('online', null, t)).toEqual({ className: 'bg-success', label: 'Çevrimiçi' })
    expect(presenceDot('online', meeting, t)).toEqual({ className: 'bg-red-500', label: 'Toplantıda · Sprint planlama' })
  })

  it('ignores ended statuses', () => {
    const ended = { ...meeting, expiresAt: new Date(Date.now() - 1000).toISOString() }
    expect(liveStatus(ended)).toBeNull()
    expect(presenceLine({ userId: 'u', state: 'online', status: ended }, t)).toBe('Çevrimiçi')
    expect(presenceLine({ userId: 'u', state: 'offline', status: { kind: 'custom', text: 'Tatilde 🌴' } }, t)).toBe('Tatilde 🌴')
  })
})
