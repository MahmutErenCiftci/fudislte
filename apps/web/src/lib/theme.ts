import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'fudislte.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function read(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

let current: Theme = read()

function apply() {
  const dark = current === 'dark' || (current === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
}

media.addEventListener('change', apply)

export function setTheme(theme: Theme) {
  current = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts for this tab.
  }
  apply()
  for (const l of listeners) l()
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}
