import type { Participant, RemoteParticipant, RemoteTrack, Room, Track } from 'livekit-client'
import { useSyncExternalStore } from 'react'

import { errorMessage } from '../../lib/api'
import { t } from '../../i18n'
import { type VoiceKind, type VoiceTarget, voiceCalls } from './target'

/**
 * The one voice connection of this window (docs/decisions/0011), to a room's voice or a
 * meeting's call. It lives outside React routes, so it survives navigation; the sidebar
 * dock and the room or meeting page render it.
 */

export interface VoiceMember {
  id: string
  name: string
  isLocal: boolean
  speaking: boolean
  muted: boolean
  camera: boolean
  screen: boolean
}

export interface VideoFeed {
  key: string
  participantId: string
  name: string
  isLocal: boolean
  source: 'camera' | 'screen'
  track: Track
}

export interface VoiceSnapshot {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting'
  /** The room or meeting of the connection; unset while idle. */
  target?: VoiceTarget
  members: VoiceMember[]
  videos: VideoFeed[]
  micEnabled: boolean
  deafened: boolean
  camera: boolean
  screen: boolean
  pushToTalk: boolean
  talking: boolean
  /** The browser blocked audio until the next click. */
  audioBlocked: boolean
  error?: string
}

const idle: VoiceSnapshot = {
  status: 'idle',
  members: [],
  videos: [],
  micEnabled: false,
  deafened: false,
  camera: false,
  screen: false,
  pushToTalk: readFlag('fudislte.voice.pushToTalk'),
  talking: false,
  audioBlocked: false,
}

let snapshot: VoiceSnapshot = idle
let room: Room | null = null
/** Bumped by every join and leave; a join that finds it changed has been superseded. */
let attempts = 0

type LiveKit = typeof import('livekit-client')
// Loaded on first use, so people who never join a call do not download it.
let livekit: LiveKit | undefined
async function loadLivekit(): Promise<LiveKit> {
  return (livekit ??= await import('livekit-client'))
}
const listeners = new Set<() => void>()
const audioElements = new Map<string, HTMLMediaElement>()
const volumes = readVolumes()

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function readVolumes(): Map<string, number> {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem('fudislte.voice.volumes') ?? '{}') as Record<string, number>))
  } catch {
    return new Map()
  }
}

function saveVolumes() {
  try {
    localStorage.setItem('fudislte.voice.volumes', JSON.stringify(Object.fromEntries(volumes)))
  } catch {
    // Volumes are a convenience; they reset when storage is unavailable.
  }
}

function set(patch: Partial<VoiceSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  for (const l of listeners) l()
}

export function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => snapshot,
  )
}

export function clearVoiceError() {
  set({ error: undefined })
}

export function getVoice(): VoiceSnapshot {
  return snapshot
}

/** Whether this window is connected (or connecting) to the call of a room or meeting. */
export function isInCall(voice: VoiceSnapshot, kind: VoiceKind, id: string): boolean {
  return voice.status !== 'idle' && voice.target?.kind === kind && voice.target.id === id
}

function member(p: Participant, isLocal: boolean): VoiceMember {
  return {
    id: p.identity,
    name: p.name || p.identity,
    isLocal,
    speaking: p.isSpeaking,
    muted: !p.isMicrophoneEnabled,
    camera: p.isCameraEnabled,
    screen: p.isScreenShareEnabled,
  }
}

function feeds(lk: LiveKit, p: Participant, isLocal: boolean): VideoFeed[] {
  const out: VideoFeed[] = []
  for (const [source, kind] of [
    [lk.Track.Source.ScreenShare, 'screen'],
    [lk.Track.Source.Camera, 'camera'],
  ] as const) {
    const pub = p.getTrackPublication(source)
    if (pub?.track && !pub.isMuted) {
      out.push({ key: `${p.identity}:${kind}`, participantId: p.identity, name: p.name || p.identity, isLocal, source: kind, track: pub.track })
    }
  }
  return out
}

/** Recomputes members and video feeds from the LiveKit room. */
function refresh() {
  const lk = livekit
  if (!room || !lk) return
  const local = room.localParticipant
  const remotes = [...room.remoteParticipants.values()]
  const members = [member(local, true), ...remotes.map((p) => member(p, false))].sort((a, b) =>
    a.name.localeCompare(b.name, 'tr'),
  )
  set({
    members,
    videos: [...feeds(lk, local, true), ...remotes.flatMap((p) => feeds(lk, p, false))],
    micEnabled: local.isMicrophoneEnabled,
    camera: local.isCameraEnabled,
    screen: local.isScreenShareEnabled,
  })
}

function attachAudio(lk: LiveKit, track: RemoteTrack, participant: RemoteParticipant) {
  if (track.kind !== lk.Track.Kind.Audio || !track.sid) return
  const el = track.attach()
  el.dataset.fudislteVoice = participant.identity
  el.muted = snapshot.deafened
  document.body.appendChild(el)
  audioElements.set(track.sid, el)
  participant.setVolume(volumes.get(participant.identity) ?? 1)
}

function detachAudio(track: RemoteTrack) {
  if (!track.sid) return
  for (const el of track.detach()) el.remove()
  audioElements.delete(track.sid)
}

/** Joins the call of a room or meeting, leaving any other first. */
export async function joinVoice(target: VoiceTarget) {
  if (room && isInCall(snapshot, target.kind, target.id)) return
  const attempt = ++attempts
  await disconnect()
  set({ ...idle, pushToTalk: snapshot.pushToTalk, status: 'connecting', target, error: undefined })
  let r: Room | undefined
  try {
    const [lk, ticket] = await Promise.all([loadLivekit(), voiceCalls(target.kind).join(target.orgId, target.id)])
    // Another join or a leave came while the ticket was on its way.
    if (attempt !== attempts) return
    const { DisconnectReason, RoomEvent } = lk
    r = new lk.Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const current = r
    room = r
    r.on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        attachAudio(lk, track, participant)
        refresh()
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        detachAudio(track)
        refresh()
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => set({ audioBlocked: !current.canPlaybackAudio }))
      .on(RoomEvent.Reconnecting, () => set({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => set({ status: 'connected' }))
      .on(RoomEvent.Disconnected, (reason) => {
        if (room !== current) return
        cleanup()
        const removed = target.kind === 'meeting' ? t('voice.removedMeeting') : t('voice.removed')
        set({
          ...idle,
          pushToTalk: snapshot.pushToTalk,
          error: reason === DisconnectReason.PARTICIPANT_REMOVED ? removed : undefined,
        })
      })
    await r.connect(ticket.url, ticket.token)
    if (room !== r) {
      // Left or switched calls while connecting: this connection must not linger.
      void r.disconnect()
      return
    }
    set({ status: 'connected', audioBlocked: !r.canPlaybackAudio })
    refresh()
    // Without a microphone (or its permission) people still listen.
    if (!snapshot.pushToTalk) await run((x) => x.localParticipant.setMicrophoneEnabled(true))
  } catch (err) {
    if (r) void r.disconnect()
    // A newer join or a leave owns the state now.
    if (attempt !== attempts) return
    if (room === r) cleanup()
    set({ ...idle, pushToTalk: snapshot.pushToTalk, error: errorMessage(err) })
  }
}

function cleanup() {
  for (const el of audioElements.values()) el.remove()
  audioElements.clear()
  room = null
}

export async function leaveVoice() {
  attempts++
  await disconnect()
}

async function disconnect() {
  const r = room
  if (!r) {
    if (snapshot.status !== 'idle') set({ ...idle, pushToTalk: snapshot.pushToTalk })
    return
  }
  cleanup()
  set({ ...idle, pushToTalk: snapshot.pushToTalk })
  await r.disconnect()
}

/** Called when access ends (a room admission, a meeting invitation): the server disconnects us too. */
export function leaveVoiceIfIn(kind: VoiceKind, id: string) {
  if (snapshot.target?.kind === kind && snapshot.target.id === id) void leaveVoice()
}

async function run(action: (r: Room) => Promise<unknown>) {
  if (!room) return
  try {
    await action(room)
    refresh()
  } catch (err) {
    set({ error: errorMessage(err) })
  }
}

export const toggleMicrophone = () => run((r) => r.localParticipant.setMicrophoneEnabled(!r.localParticipant.isMicrophoneEnabled))
export const toggleCamera = () => run((r) => r.localParticipant.setCameraEnabled(!r.localParticipant.isCameraEnabled))
export const toggleScreenShare = () =>
  run((r) => r.localParticipant.setScreenShareEnabled(!r.localParticipant.isScreenShareEnabled, { audio: true }))

/** Deafened: hear nobody, and the microphone goes off with it. */
export function toggleDeafen() {
  const deafened = !snapshot.deafened
  for (const el of audioElements.values()) el.muted = deafened
  set({ deafened })
  if (deafened && room?.localParticipant.isMicrophoneEnabled) void run((r) => r.localParticipant.setMicrophoneEnabled(false))
}

export function setVolume(participantId: string, volume: number) {
  volumes.set(participantId, volume)
  saveVolumes()
  room?.remoteParticipants.get(participantId)?.setVolume(volume)
  set({}) // re-render sliders
}

export function getVolume(participantId: string): number {
  return volumes.get(participantId) ?? 1
}

/** Starts audio playback after a click when the browser blocked autoplay. */
export function resumeAudio() {
  void room?.startAudio().then(() => set({ audioBlocked: false }))
}

export async function microphones(): Promise<MediaDeviceInfo[]> {
  return (await loadLivekit()).Room.getLocalDevices('audioinput')
}

export const chooseMicrophone = (deviceId: string) => run((r) => r.switchActiveDevice('audioinput', deviceId))

/** Push to talk: the microphone is live only while Ctrl+Space is held. */
export function setPushToTalk(on: boolean) {
  try {
    localStorage.setItem('fudislte.voice.pushToTalk', String(on))
  } catch {
    // Not remembered on this device.
  }
  set({ pushToTalk: on })
  void run((r) => r.localParticipant.setMicrophoneEnabled(!on))
}

function talk(on: boolean) {
  if (!room || !snapshot.pushToTalk || snapshot.deafened || snapshot.talking === on) return
  set({ talking: on })
  void run((r) => r.localParticipant.setMicrophoneEnabled(on))
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.ctrlKey && snapshot.pushToTalk && room) {
      e.preventDefault()
      talk(true)
    }
  })
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.key === 'Control') talk(false)
  })
  window.addEventListener('blur', () => talk(false))
}

