import type { Channel } from '@fudislte/api-client'

import type { MessageKey, Vars } from '../../i18n'

type Translate = (key: MessageKey, vars?: Vars) => string
type Person = { id: string; displayName: string }

/** The other people in a direct conversation; empty for notes to self. */
export function otherParticipants(c: Pick<Channel, 'participants'>, meId: string): Person[] {
  return (c.participants ?? []).filter((p) => p.id !== meId)
}

/**
 * What to call a channel or conversation: "backend", "Ayşe Demir",
 * "Ayşe Demir, Mehmet Kaya" or "Ayşe Demir, Mehmet Kaya and 2 others".
 */
export function channelTitle(c: Pick<Channel, 'kind' | 'name' | 'participants'>, meId: string, t: Translate): string {
  if (c.kind !== 'direct') return c.name
  const others = otherParticipants(c, meId)
  const self = c.participants?.find((p) => p.id === meId)
  if (others.length === 0) return t('dm.self', { name: self?.displayName ?? '' })
  if (others.length <= 3) return others.map((p) => p.displayName).join(', ')
  return t('dm.andOthers', {
    names: others
      .slice(0, 2)
      .map((p) => p.displayName)
      .join(', '),
    count: others.length - 2,
  })
}

/** Like channelTitle, with "#" before channel names: "#backend", "Güvenlik Odası", "Ayşe Demir". */
export function channelLabel(c: Pick<Channel, 'kind' | 'name' | 'participants'>, meId: string, t: Translate): string {
  return c.kind === 'channel' ? `#${c.name}` : channelTitle(c, meId, t)
}
