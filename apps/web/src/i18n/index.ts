// Small, typed i18n layer. The language lives in one store: it starts from the saved
// choice (or the browser), follows the signed-in user's account setting, and every
// component that calls useT() re-renders when it changes.
import { useCallback, useSyncExternalStore } from 'react'

import { en } from './en'
import { type Messages, tr } from './tr'

export type Language = 'tr' | 'en'
export type MessageKey = keyof Messages
export type Vars = Record<string, string | number>

export const languages: { code: Language; label: string }[] = [
  { code: 'tr', label: 'Türkçe' },
  { code: 'en', label: 'English' },
]

/** BCP 47 tags for Intl date and number formatting. */
export const intlLocale: Record<Language, string> = { tr: 'tr-TR', en: 'en-US' }

const dictionaries: Record<Language, Messages> = { tr, en }
const STORAGE_KEY = 'fudislte.language'
const listeners = new Set<() => void>()

export function isLanguage(v: unknown): v is Language {
  return v === 'tr' || v === 'en'
}

function detect(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLanguage(saved)) return saved
  } catch {
    // Storage unavailable: fall back to the browser language.
  }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en') ? 'en' : 'tr'
}

let current: Language = detect()
if (typeof document !== 'undefined') document.documentElement.lang = current

export function getLanguage(): Language {
  return current
}

export function setLanguage(language: Language) {
  if (language === current) return
  current = language
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // The choice still applies to this tab.
  }
  if (typeof document !== 'undefined') document.documentElement.lang = language
  for (const l of listeners) l()
}

export function useLanguage(): Language {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}

/** Looks up key in language and fills {placeholders}; uses key_one when count is 1. */
export function translate(language: Language, key: MessageKey, vars?: Vars): string {
  const dict = dictionaries[language]
  let template = dict[key]
  if (vars?.count === 1) {
    const one = (dict as Record<string, string>)[`${key}_one`]
    if (one) template = one
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (vars && name in vars ? String(vars[name]) : match))
}

/** Translation function for the current language; re-renders on language change. */
export function useT() {
  const language = useLanguage()
  return useCallback((key: MessageKey, vars?: Vars) => translate(language, key, vars), [language])
}

/** For code outside components (formatters, error helpers): uses the current language. */
export function t(key: MessageKey, vars?: Vars): string {
  return translate(current, key, vars)
}

export function hasKey(key: string): key is MessageKey {
  return key in tr
}
