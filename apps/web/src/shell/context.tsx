import type { Me, Workspace } from '@fudislte/api-client'
import { createContext, useCallback, useContext, useState } from 'react'

export interface WorkspaceContextValue {
  me: Me
  workspace: Workspace
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

/** The signed-in user and the workspace selected by the URL. */
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside a workspace route')
  return value
}

interface ShellContextValue {
  canSeeMembers: boolean
  memberPanelOpen: boolean
  toggleMemberPanel: () => void
  /** A page shows its own side panel (e.g. a thread): the people list steps aside. */
  setAsideTaken: (taken: boolean) => void
}

export const ShellContext = createContext<ShellContextValue>({
  canSeeMembers: false,
  memberPanelOpen: false,
  toggleMemberPanel: () => {},
  setAsideTaken: () => {},
})

export const useShell = () => useContext(ShellContext)

/** useState backed by localStorage, for per-device UI preferences. */
export function usePersistentState(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored === null ? initial : stored === 'true'
    } catch {
      return initial
    }
  })
  const update = useCallback(
    (v: boolean) => {
      setValue(v)
      try {
        localStorage.setItem(key, String(v))
      } catch {
        // Preference is kept for this session only.
      }
    },
    [key],
  )
  return [value, update]
}
