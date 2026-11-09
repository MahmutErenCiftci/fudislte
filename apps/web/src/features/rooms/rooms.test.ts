import { describe, expect, it } from 'vitest'

import { setLanguage } from '../../i18n'
import { admissionChoices, formatMinutes } from './rooms'

describe('room admission lengths', () => {
  it('names durations in the largest whole unit', () => {
    setLanguage('tr')
    expect(formatMinutes(15)).toBe('15 dakika')
    expect(formatMinutes(60)).toBe('1 saat')
    expect(formatMinutes(12 * 60)).toBe('12 saat')
    expect(formatMinutes(7 * 24 * 60)).toBe('7 gün')
    setLanguage('en')
    expect(formatMinutes(1)).toBe('1 minute')
    expect(formatMinutes(24 * 60)).toBe('1 day')
    expect(formatMinutes(90)).toBe('2 hours')
  })

  it('offers only lengths the server accepts', () => {
    expect(admissionChoices.every((m) => m >= 15 && m <= 30 * 24 * 60)).toBe(true)
  })
})
