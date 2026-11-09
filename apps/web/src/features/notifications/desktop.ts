import type { Me } from '@fudislte/api-client'
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

import { queryKeys } from '../../lib/api'
import { liveStatus } from '../presence/presence'

// Desktop (operating system) notifications. Which ones to show is a per-device choice;
// the person's status can mute them; nothing shows for the conversation on screen.

export type DesktopPreference = 'all' | 'mentions' | 'off'

const STORAGE_KEY = 'fudislte.desktopNotifications'
const listeners = new Set<() => void>()

export function getDesktopPreference(): DesktopPreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'all' || v === 'mentions' || v === 'off') return v
  } catch {
    // Storage unavailable: use the default.
  }
  return 'all'
}

export function setDesktopPreference(p: DesktopPreference) {
  try {
    localStorage.setItem(STORAGE_KEY, p)
  } catch {
    // Applies to this tab only.
  }
  for (const l of listeners) l()
}

export function useDesktopPreference(): DesktopPreference {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getDesktopPreference,
  )
}

export const desktopSupported = () => typeof Notification !== 'undefined'

/** Opens the place a notification is about; set by the app shell, which can navigate. */
let open: ((orgId: string, channelId: string, threadId?: string) => void) | null = null

export function setNotificationTarget(fn: typeof open) {
  open = fn
}

export interface DesktopNotice {
  /** "mention" and "reply" pass the "mentions" preference; "message" needs "all". */
  kind: 'mention' | 'reply' | 'message'
  title: string
  body: string
  /** Same tag, one notification: repeats from several tabs replace each other. */
  tag: string
  orgId: string
  channelId: string
  threadId?: string
}

export function showDesktop(qc: QueryClient, notice: DesktopNotice) {
  if (!desktopSupported() || Notification.permission !== 'granted') return
  const pref = getDesktopPreference()
  if (pref === 'off' || (pref === 'mentions' && notice.kind === 'message')) return
  const me = qc.getQueryData<Me | null>(queryKeys.me)
  if (liveStatus(me?.user.status)?.mute) return
  const n = new Notification(notice.title, { body: notice.body, tag: notice.tag })
  n.onclick = () => {
    window.focus()
    open?.(notice.orgId, notice.channelId, notice.threadId)
    n.close()
  }
}
