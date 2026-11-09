import type { TaskActivity, TaskPriority } from '@fudislte/api-client'

import { type MessageKey, t } from '../../i18n'

type Named = { name?: string; displayName?: string } | null | undefined

const name = (v: unknown): string => {
  const n = v as Named
  return n?.name ?? n?.displayName ?? ''
}

const isPriority = (v: unknown): v is TaskPriority => ['none', 'low', 'medium', 'high', 'urgent'].includes(String(v))

/** One activity entry as a sentence continuing the actor's name ("… durumu İncelemede yaptı"). */
export function describeActivity(e: Pick<TaskActivity, 'kind' | 'data'>, formatDate: (d: string) => string): string {
  const d = e.data
  switch (e.kind) {
    case 'created':
      return t('activity.created')
    case 'status_changed':
      return t('activity.status', { from: name(d.from), to: name(d.to) })
    case 'assigned':
      return t('activity.assigned', { name: name(d.user) })
    case 'unassigned':
      return t('activity.unassigned', { name: name(d.user) })
    case 'priority_changed':
      return t('activity.priority', {
        to: isPriority(d.to) ? t(`tasks.priority.${d.to}` as MessageKey) : String(d.to ?? ''),
      })
    case 'due_changed':
      return typeof d.to === 'string' ? t('activity.due', { date: formatDate(d.to) }) : t('activity.dueCleared')
    case 'sprint_changed':
      return d.to ? t('activity.sprint', { sprint: name(d.to) }) : t('activity.backlog')
    case 'title_changed':
      return t('activity.title', { title: String(d.to ?? '') })
    case 'description_changed':
      return t('activity.description')
    case 'labels_changed': {
      const added = Array.isArray(d.added) ? d.added.map(String) : []
      const removed = Array.isArray(d.removed) ? d.removed.map(String) : []
      return t('activity.labels', { changes: [...added.map((l) => `+${l}`), ...removed.map((l) => `−${l}`)].join(', ') })
    }
    case 'linked':
      return d.channel ? t('activity.linked', { name: name(d.channel) }) : t('activity.linkedHidden')
    case 'unlinked':
      return d.channel ? t('activity.unlinked', { name: name(d.channel) }) : t('activity.unlinkedHidden')
  }
  return ''
}
