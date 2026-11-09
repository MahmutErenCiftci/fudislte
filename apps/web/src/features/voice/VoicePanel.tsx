import {
  Alert,
  Avatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from '@fudislte/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AudioLinesIcon,
  ChevronDownIcon,
  HeadphoneOffIcon,
  HeadphonesIcon,
  MicIcon,
  MicOffIcon,
  MonitorUpIcon,
  PhoneOffIcon,
  UserXIcon,
  VideoIcon,
  VideoOffIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../i18n'
import { errorMessage } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { type VoiceKind, voiceCalls, voiceKey } from './target'
import {
  chooseMicrophone,
  getVolume,
  isInCall,
  joinVoice,
  leaveVoice,
  microphones,
  resumeAudio,
  setPushToTalk,
  setVolume,
  toggleCamera,
  toggleDeafen,
  toggleMicrophone,
  toggleScreenShare,
  useVoice,
  type VideoFeed,
  type VoiceMember,
} from './voice'

/**
 * The call of an admitted room or of a meeting, under its header (mockups "Yeni 05" and
 * "Yeni 06"). Room managers and a meeting's organizer moderate it; `unavailable` says
 * why nobody can join now (a meeting outside its window) and hides the join button.
 */
export function VoicePanel({
  kind,
  id,
  name,
  canModerate,
  unavailable,
}: {
  kind: VoiceKind
  id: string
  name: string
  canModerate: boolean
  unavailable?: string
}) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const voice = useVoice()
  const here = isInCall(voice, kind, id)
  const state = useQuery({
    queryKey: voiceKey(orgId, kind, id),
    queryFn: () => voiceCalls(kind).state(orgId, id),
    enabled: !here,
  })
  if (state.data && !state.data.enabled) {
    if (kind === 'room') return null
    return (
      <section className="shrink-0 border-b px-6 py-3">
        <p className="rounded-xl border bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">{t('meetings.noMedia')}</p>
      </section>
    )
  }

  const join = () => void joinVoice({ kind, id, name, orgId, slug: workspace.organization.slug })

  if (!here) {
    const people = state.data?.participants ?? []
    return (
      <section className="shrink-0 border-b px-6 py-3">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3">
          {kind === 'meeting' ? <VideoIcon className="size-5 text-primary" /> : <AudioLinesIcon className="size-5 text-primary" />}
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium">{kind === 'meeting' ? t('meetings.call') : t('voice.title')}</p>
            <p className="text-[13px] text-muted-foreground">
              {unavailable ?? (people.length === 0 ? t('voice.nobody') : t('voice.inVoice', { count: people.length }))}
            </p>
          </div>
          {people.length > 0 && (
            <div className="flex -space-x-2">
              {people.slice(0, 6).map((p) => (
                <Avatar key={p.userId} name={p.displayName} seed={p.userId} size="sm" className="ring-2 ring-background" />
              ))}
            </div>
          )}
          {!unavailable && (
            <Button onClick={join}>
              {kind === 'meeting' ? <VideoIcon /> : <MicIcon />}
              {kind === 'meeting' ? t('meetings.joinCall') : t('voice.join')}
            </Button>
          )}
        </div>
        {voice.error && voice.status === 'idle' && (
          <Alert variant="error" className="mt-2">
            {voice.error}
          </Alert>
        )}
      </section>
    )
  }

  return (
    <section className="shrink-0 border-b px-6 py-4">
      {voice.status !== 'connected' ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner className="size-4" />
          {voice.status === 'connecting' ? t('voice.connecting') : t('voice.reconnecting')}
        </div>
      ) : (
        <>
          {voice.videos.length > 0 && (
            <div className={cn('mb-4 grid gap-3', voice.videos.length > 1 && 'sm:grid-cols-2')}>
              {voice.videos.map((v) => (
                <VideoTile key={v.key} feed={v} />
              ))}
            </div>
          )}
          <ul className="flex flex-wrap gap-5">
            {voice.members.map((m) => (
              <li key={m.id}>
                <MemberBubble member={m} kind={kind} id={id} canModerate={canModerate} />
              </li>
            ))}
          </ul>
          {voice.audioBlocked && (
            <button
              type="button"
              onClick={resumeAudio}
              className="mt-3 w-full rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-left text-[13px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
            >
              {t('voice.audioBlocked')}
            </button>
          )}
          <VoiceControls />
        </>
      )}
      {voice.error && (
        <Alert variant="error" className="mt-3">
          {voice.error}
        </Alert>
      )}
    </section>
  )
}

function MemberBubble({
  member,
  kind,
  id,
  canModerate,
}: {
  member: VoiceMember
  kind: VoiceKind
  id: string
  canModerate: boolean
}) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const [volume, setLocalVolume] = useState(() => getVolume(member.id))
  const mute = useMutation({ mutationFn: () => voiceCalls(kind).mute(orgId, id, member.id) })
  const remove = useMutation({ mutationFn: () => voiceCalls(kind).remove(orgId, id, member.id) })
  const status = member.muted ? t('voice.mutedLabel') : member.speaking ? t('voice.talking') : t('voice.listening')
  const bubble = (
    <span className="flex w-20 flex-col items-center gap-1.5 text-center">
      <span
        className={cn(
          'relative rounded-full p-0.5 ring-2 transition-shadow',
          member.speaking && !member.muted ? 'ring-emerald-500 shadow-[0_0_0_4px] shadow-emerald-500/20' : 'ring-transparent',
        )}
      >
        <Avatar name={member.name} seed={member.id} size="lg" />
        {member.muted && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full bg-background text-destructive">
            <MicOffIcon className="size-3.5" />
          </span>
        )}
      </span>
      <span className="w-full truncate text-[13px] font-medium">
        {member.name}
        {member.isLocal && <span className="font-normal text-muted-foreground"> {t('voice.you')}</span>}
      </span>
      <span className={cn('text-xs', member.speaking && !member.muted ? 'text-primary' : 'text-muted-foreground')}>{status}</span>
    </span>
  )
  if (member.isLocal) return bubble
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={member.name}>
        {bubble}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{member.name}</DropdownMenuLabel>
        <div className="px-2 pb-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t('voice.volume')} · {Math.round(volume * 100)}%
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => {
                const v = Number(e.target.value)
                setLocalVolume(v)
                setVolume(member.id, v)
              }}
              className="accent-[var(--color-primary)]"
            />
          </label>
        </div>
        {canModerate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={member.muted || mute.isPending} onSelect={() => mute.mutate()}>
              <MicOffIcon />
              {t('voice.muteFor')}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => remove.mutate()}>
              <UserXIcon />
              {kind === 'meeting' ? t('meetings.removeFromCall') : t('voice.removeFrom')}
            </DropdownMenuItem>
          </>
        )}
        {(mute.error || remove.error) && (
          <p className="px-2 py-1 text-xs text-destructive">{errorMessage(mute.error ?? remove.error)}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function VideoTile({ feed }: { feed: VideoFeed }) {
  const t = useT()
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    feed.track.attach(el)
    return () => {
      feed.track.detach(el)
    }
  }, [feed.track])
  return (
    <figure className="relative overflow-hidden rounded-xl border bg-black">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={cn('aspect-video max-h-[45vh] w-full object-contain', feed.isLocal && feed.source === 'camera' && '-scale-x-100')}
      />
      <figcaption className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-xs text-white">
        {feed.source === 'screen' ? t('voice.screenOf', { name: feed.name }) : feed.name}
      </figcaption>
    </figure>
  )
}

/** The bar at the bottom of the mockup: microphone, headphones, camera, screen, leave. */
export function VoiceControls({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const voice = useVoice()
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const label = (text: string) => (compact ? undefined : text)
  const button = (
    active: boolean,
    on: React.ReactNode,
    off: React.ReactNode,
    text: string,
    tip: string,
    onClick: () => void,
  ) => (
    <Tooltip content={tip} side="top">
      <Button
        variant={active ? 'outline' : 'secondary'}
        size={compact ? 'icon' : 'sm'}
        className={cn(!compact && 'h-9', !active && 'text-destructive')}
        aria-label={tip}
        aria-pressed={!active}
        onClick={onClick}
      >
        {active ? on : off}
        {label(text)}
      </Button>
    </Tooltip>
  )
  return (
    <div className={cn('flex flex-wrap items-center gap-2', !compact && 'mt-4 rounded-xl border bg-card p-2 shadow-sm')}>
      <div className="flex">
        {button(
          voice.micEnabled,
          <MicIcon />,
          <MicOffIcon />,
          voice.pushToTalk ? t('voice.pushToTalkShort') : t('voice.mic'),
          voice.micEnabled ? t('voice.micOn') : t('voice.micOff'),
          () => void toggleMicrophone(),
        )}
        {!compact && (
          <DropdownMenu onOpenChange={(open) => open && void microphones().then(setMics)}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9" aria-label={t('voice.chooseMic')}>
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>{t('voice.chooseMic')}</DropdownMenuLabel>
              {mics.map((d) => (
                <DropdownMenuItem key={d.deviceId} onSelect={() => void chooseMicrophone(d.deviceId)}>
                  <span className="truncate">{d.label || d.deviceId}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setPushToTalk(!voice.pushToTalk)}>
                {voice.pushToTalk ? '✓ ' : ''}
                {t('voice.pushToTalk')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {button(
        !voice.deafened,
        <HeadphonesIcon />,
        <HeadphoneOffIcon />,
        t('voice.headphones'),
        voice.deafened ? t('voice.undeafen') : t('voice.deafen'),
        toggleDeafen,
      )}
      {!compact && (
        <>
          <Button variant={voice.camera ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => void toggleCamera()}>
            {voice.camera ? <VideoIcon /> : <VideoOffIcon />}
            {voice.camera ? t('voice.stopCamera') : t('voice.camera')}
          </Button>
          <Button
            variant={voice.screen ? 'default' : 'outline'}
            size="sm"
            className="h-9"
            onClick={() => void toggleScreenShare()}
          >
            <MonitorUpIcon />
            {voice.screen ? t('voice.stopScreen') : t('voice.screen')}
          </Button>
        </>
      )}
      <Button
        variant="destructive"
        size={compact ? 'icon' : 'sm'}
        className={cn(!compact && 'ml-auto h-9')}
        aria-label={t('voice.leave')}
        onClick={() => void leaveVoice()}
      >
        <PhoneOffIcon />
        {label(t('voice.leave'))}
      </Button>
    </div>
  )
}
