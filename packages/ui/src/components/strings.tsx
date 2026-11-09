import { createContext, type ReactNode, useContext } from 'react'

/** The few words components render themselves; the app provides translations. */
export interface UiStrings {
  close: string
  loading: string
  online: string
}

const UiStringsContext = createContext<UiStrings>({ close: 'Close', loading: 'Loading', online: 'Online' })

export function UiStringsProvider({ value, children }: { value: UiStrings; children: ReactNode }) {
  return <UiStringsContext.Provider value={value}>{children}</UiStringsContext.Provider>
}

export const useUiStrings = () => useContext(UiStringsContext)
