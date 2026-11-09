import type { PresenceEntry, PresenceState, StatusKind, UserStatus } from '@fudislte/api-client'
import { type QueryClient, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import type { MessageKey, Vars } from '../../i18n'
import { api, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'

type Translate = (key: MessageKey, vars?: Vars) => string

/** Status presets, with the dot colors of the mockup's people list. */
export const statusKinds: { kind: StatusKind; emoji: string; label: MessageKey; dot: string; mute: boolean }[] = [
  { kind: 'meeting', emoji: '📅', label: 'status.meeting', dot: 'bg-red-500', mute: true },
  { kind: 'coding', emoji: '💻', label: 'status.coding', dot: 'bg-blue-500', mute: false },
  { kind: 'focus', emoji: '🎯', label: 'status.focus', dot: 'bg-violet-500', mute: true },
  { kind: 'call', emoji: '📞', label: 'status.call', dot: 'bg-amber-500', mute: true },
  { kind: 'custom', emoji: '💬', label: 'status.custom', dot: 'bg-success', mute: false },
]

export function kindInfo(kind: StatusKind) {
  return statusKinds.find((k) => k.kind === kind) ?? statusKinds[statusKinds.length - 1]!
}

/** The status, unless it has ended. */
export function liveStatus<S extends UserStatus>(status: S | null | undefined, now = Date.now()): S | null {
  if (!status) return null
  if (status.expiresAt && new Date(status.expiresAt).getTime() <= now) return null
  return status
}

/** The dot on someone's avatar: none when offline, gray when away, else the status color. */
export function presenceDot(
  state: PresenceState | undefined,
  status: UserStatus | null | undefined,
  t: Translate,
): { className: string; label: string } | undefined {
  if (!state || state === 'offline') return undefined
  if (state === 'away') return { className: 'bg-slate-400', label: t('presence.away') }
  const s = liveStatus(status)
  if (s) return { className: kindInfo(s.kind).dot, label: statusLabel(s, t) }
  return { className: 'bg-success', label: t('presence.online') }
}

/** "Toplantıda · Sprint planlama", or the custom text. */
export function statusLabel(status: UserStatus, t: Translate): string {
  if (status.kind === 'custom') return status.text
  const label = t(kindInfo(status.kind).label)
  return status.text ? `${label} · ${status.text}` : label
}

/** The line under a name in the people list. */
export function presenceLine(entry: PresenceEntry | undefined, t: Translate): string {
  if (!entry) return ''
  const s = liveStatus(entry.status)
  if (s) return statusLabel(s, t)
  if (entry.state === 'online') return t('presence.online')
  if (entry.state === 'away') return t('presence.away')
  return ''
}

/** Presence of the workspace's members, kept current by live events. */
export function usePresenceMap(): Map<string, PresenceEntry> {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const presence = useQuery({
    queryKey: queryKeys.presence(orgId),
    queryFn: () => api.presence(orgId),
    enabled: can(workspace, 'members.view'),
    staleTime: Infinity,
  })
  return useMemo(() => new Map((presence.data ?? []).map((e) => [e.userId, e])), [presence.data])
}

/** Applies a presence.changed event to every workspace's cached list. */
export function applyPresence(qc: QueryClient, entry: PresenceEntry) {
  qc.setQueriesData<PresenceEntry[]>(
    { predicate: (q) => q.queryKey[0] === 'orgs' && q.queryKey[2] === 'presence' },
    (list) => list?.map((e) => (e.userId === entry.userId ? entry : e)),
  )
}

const IDLE_AFTER_MS = 5 * 60_000

/**
 * Watches for input and window visibility. Calls onChange(false) after five minutes
 * without input or when the window is hidden, and onChange(true) when the person is back.
 */
export function trackActivity(onChange: (active: boolean) => void): { active: () => boolean; stop: () => void } {
  let active = document.visibilityState === 'visible'
  let timer: ReturnType<typeof setTimeout> | undefined
  const set = (next: boolean) => {
    if (next !== active) {
      active = next
      onChange(next)
    }
  }
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => set(false), IDLE_AFTER_MS)
  }
  const onInput = () => {
    if (document.visibilityState !== 'visible') return
    set(true)
    arm()
  }
  const onVisibility = () => (document.visibilityState === 'visible' ? onInput() : set(false))
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus'] as const
  for (const e of events) window.addEventListener(e, onInput, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  arm()
  return {
    active: () => active,
    stop: () => {
      clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, onInput)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
