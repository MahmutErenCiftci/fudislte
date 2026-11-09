import type { VoiceState, VoiceTicket } from '@fudislte/api-client'

import { api, queryKeys } from '../../lib/api'

/** Calls happen in rooms (their voice) and in meetings; each has its own LiveKit room. */
export type VoiceKind = 'room' | 'meeting'

/** Where the voice connection goes, with what the dock needs to show and link it. */
export interface VoiceTarget {
  kind: VoiceKind
  id: string
  name: string
  orgId: string
  slug: string
}

/** The page of a call: /w/:slug/r/:roomId or /w/:slug/m/:meetingId. */
export function voicePath(target: Pick<VoiceTarget, 'kind' | 'id' | 'slug'>): string {
  return `/w/${target.slug}/${target.kind === 'meeting' ? 'm' : 'r'}/${target.id}`
}

/** Who is in a call, kept current by voice.updated events. */
export function voiceKey(orgId: string, kind: VoiceKind, id: string) {
  return kind === 'meeting' ? queryKeys.meetingVoice(orgId, id) : queryKeys.voice(orgId, id)
}

interface VoiceCalls {
  join: (orgId: string, id: string) => Promise<VoiceTicket>
  state: (orgId: string, id: string) => Promise<VoiceState>
  mute: (orgId: string, id: string, userId: string) => Promise<void>
  remove: (orgId: string, id: string, userId: string) => Promise<void>
}

/** The API of a room's voice or a meeting's call; moderation is for room managers or the organizer. */
export function voiceCalls(kind: VoiceKind): VoiceCalls {
  return kind === 'meeting'
    ? { join: api.joinMeetingVoice, state: api.meetingVoiceState, mute: api.muteInMeeting, remove: api.removeFromMeeting }
    : { join: api.joinVoice, state: api.voiceState, mute: api.muteInVoice, remove: api.removeFromVoice }
}
