import type { AuditEvent } from '@fudislte/api-client'

import { getLanguage, hasKey, t } from '../i18n'

/** Human label for an audit action; unknown actions show their raw name. */
export function auditLabel(action: string): string {
  const key = `audit.${action}`
  return hasKey(key) ? t(key) : action
}

/** The label continuing a sentence ("Alex, created a role"), lower-casing only its first letter. */
export function auditPhrase(action: string): string {
  const label = auditLabel(action)
  return label.charAt(0).toLocaleLowerCase(getLanguage()) + label.slice(1)
}

function change(v: unknown): string | undefined {
  if (v && typeof v === 'object' && 'from' in v && 'to' in v) {
    const { from, to } = v as { from: unknown; to: unknown }
    if (JSON.stringify(from) === JSON.stringify(to)) return undefined
    return `${String(from)} → ${String(to)}`
  }
  return undefined
}

const isVisibility = (v: unknown): v is 'public' | 'private' => v === 'public' || v === 'private'

const isAccess = (v: unknown): v is 'open' | 'protected' | 'restricted' =>
  v === 'open' || v === 'protected' || v === 'restricted'

/** A one-line summary of an event's metadata. */
export function describeEvent(e: AuditEvent): string {
  const m = e.metadata
  const parts: string[] = []
  if (typeof m.email === 'string') parts.push(m.email)
  if (typeof m.domain === 'string') parts.push(`@${m.domain}`)
  if (typeof m.fromRole === 'string' && typeof m.toRole === 'string') parts.push(`${m.fromRole} → ${m.toRole}`)
  if (typeof m.displayName === 'string') parts.push(m.displayName)
  if (typeof m.name === 'string') parts.push(m.name)
  const renamed = change(m.name)
  if (renamed) parts.push(renamed)
  const rank = change(m.position)
  if (rank) parts.push(t('audit.rank', { change: rank }))
  if (typeof m.role === 'string') parts.push(m.role)
  if (typeof m.channel === 'string') parts.push(`#${m.channel}`)
  if (typeof m.room === 'string') parts.push(m.room)
  if (typeof m.meeting === 'string') parts.push(m.meeting)
  if (typeof m.project === 'string') parts.push(m.project)
  if (typeof m.board === 'string') parts.push(m.board)
  if (typeof m.task === 'string') parts.push(m.task)
  const rekeyed = change(m.key)
  if (rekeyed) parts.push(rekeyed)
  const visibility = m.visibility as { from?: unknown; to?: unknown } | undefined
  if (visibility && typeof visibility === 'object' && isVisibility(visibility.from) && isVisibility(visibility.to)) {
    parts.push(`${t(`projects.visibility.${visibility.from}`)} → ${t(`projects.visibility.${visibility.to}`)}`)
  }
  const retitled = change(m.title)
  if (retitled) parts.push(retitled)
  if (m.startsAt && typeof m.startsAt === 'object') parts.push(t('meetings.auditRescheduled'))
  if (m.access === 'open' || m.access === 'protected' || m.access === 'restricted') parts.push(t(`rooms.access.${m.access}`))
  const access = m.access as { from?: unknown; to?: unknown } | undefined
  if (access && typeof access === 'object' && access.from !== access.to && isAccess(access.from) && isAccess(access.to)) {
    parts.push(`${t(`rooms.access.${access.from}`)} → ${t(`rooms.access.${access.to}`)}`)
  }
  if (m.passwordChanged === true) parts.push(t('rooms.auditPassword'))
  if (typeof m.admissionsEnded === 'number' && m.admissionsEnded > 0) parts.push(t('rooms.auditEnded', { count: m.admissionsEnded }))
  if (Array.isArray(m.added) && Array.isArray(m.removed)) {
    parts.push(t('rooms.auditList', { added: m.added.length, removed: m.removed.length }))
  } else if (Array.isArray(m.added)) {
    parts.push(t('projects.auditAdded', { count: m.added.length }))
  } else if (Array.isArray(m.removed)) {
    parts.push(t('projects.auditRemoved', { count: m.removed.length }))
  }
  if (m.projectRole === 'lead' || m.projectRole === 'member') parts.push(t(`projects.role.${m.projectRole}`))
  if (m.retentionDays && typeof m.retentionDays === 'object') {
    const { from, to } = m.retentionDays as { from: number | null; to: number | null }
    const days = (d: number | null) => (d ? t('retention.days', { count: d }) : t('retention.forever'))
    parts.push(`${days(from)} → ${days(to)}`)
  }
  return parts.join(' · ')
}
