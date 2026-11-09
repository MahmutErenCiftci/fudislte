import type { Room } from '@fudislte/api-client'
import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Input,
  Spinner,
  Tooltip,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckIcon,
  ClockIcon,
  EllipsisIcon,
  KeyRoundIcon,
  LinkIcon,
  LogOutIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { ConfirmDialog } from '../chat/ChannelDialogs'
import { VoicePanel } from '../voice/VoicePanel'
import { Conversation } from '../chat/ChannelPage'
import { LinkedTasks } from '../projects/LinkedTasks'
import { RoomSettingsDialog } from './RoomSettingsDialog'
import { AccessBadge, accessIcons, AdmissionLabel, formatMinutes } from './rooms'

/**
 * /w/:slug/r/:roomId — a secure room. People not admitted see the lock screen; the
 * conversation (messages, files, threads) is the channel view behind it.
 */
export function RoomPage() {
  const t = useT()
  const { roomId = '' } = useParams()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const room = useQuery({ queryKey: queryKeys.room(orgId, roomId), queryFn: () => api.room(orgId, roomId) })

  if (room.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }
  if (!room.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-[14px] text-muted-foreground">{t('rooms.notFound')}</p>
        <Button variant="outline" asChild>
          <Link to={`/w/${workspace.organization.slug}/rooms`}>{t('rooms.back')}</Link>
        </Button>
      </div>
    )
  }
  return room.data.admitted ? <AdmittedRoom key={room.data.id} room={room.data} /> : <RoomGate room={room.data} />
}

function AdmittedRoom({ room }: { room: Room }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const channel = useQuery({ queryKey: queryKeys.channel(orgId, room.id), queryFn: () => api.channel(orgId, room.id) })
  if (!channel.data) {
    return (
      <div className="flex flex-1 flex-col">
        <RoomHeader room={room} />
        <div className="flex flex-1 items-center justify-center">
          {channel.error ? <Alert variant="error">{errorMessage(channel.error)}</Alert> : <Spinner label={t('chat.loading')} />}
        </div>
      </div>
    )
  }
  return (
    <Conversation
      channel={channel.data}
      header={
        <>
          <RoomHeader room={room} />
          <VoicePanel kind="room" id={room.id} name={room.name} canModerate={room.canManage} />
          <LinkedTasks channelId={room.id} />
        </>
      }
    />
  )
}

function RoomHeader({ room }: { room: Room }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<'settings' | 'people' | 'delete' | null>(null)
  const [copied, setCopied] = useState(false)
  const Icon = accessIcons[room.access]
  const rooms = `/w/${workspace.organization.slug}/rooms`

  const leave = useMutation({
    mutationFn: () => api.leaveRoom(orgId, room.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.rooms(orgId) })
      navigate(rooms)
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteRoom(orgId, room.id),
    onSuccess: async () => {
      qc.removeQueries({ queryKey: queryKeys.room(orgId, room.id) })
      await qc.invalidateQueries({ queryKey: queryKeys.rooms(orgId) })
      navigate(rooms)
    },
  })
  const copyLink = () => {
    void navigator.clipboard?.writeText(window.location.href.split('?')[0] ?? '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <header className="shrink-0 border-b px-6 pt-4 pb-4">
      <Link
        to={rooms}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('rooms.back')}
      </Link>
      <div className="flex items-start gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">{room.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            <AccessBadge access={room.access} />
            <button
              type="button"
              onClick={() => setDialog('people')}
              className="flex items-center gap-1.5 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <UsersIcon className="size-4" />
              {t('rooms.people', { count: room.memberCount })}
            </button>
            <span className="flex items-center gap-1.5">
              <ClockIcon className="size-4" />
              <AdmissionLabel room={room} />
            </span>
          </div>
          {room.topic && <p className="mt-2 text-[13px] text-muted-foreground">{room.topic}</p>}
        </div>
        <Tooltip content={copied ? t('common.copied') : t('rooms.copyLink')} side="bottom">
          <Button variant="outline" size="icon" className="size-9" onClick={copyLink} aria-label={t('rooms.copyLink')}>
            {copied ? <CheckIcon /> : <LinkIcon />}
          </Button>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="size-9" aria-label={t('chat.options')}>
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {room.canManage && (
              <DropdownMenuItem onSelect={() => setDialog('settings')}>
                <SettingsIcon />
                {t('rooms.settings')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => leave.mutate()}>
              <LogOutIcon />
              {t('rooms.leave')}
            </DropdownMenuItem>
            {room.canManage && (
              <DropdownMenuItem onSelect={() => setDialog('delete')} className="text-destructive focus:text-destructive">
                <Trash2Icon />
                {t('rooms.delete')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {leave.error && (
        <Alert variant="error" className="mt-3">
          {errorMessage(leave.error)}
        </Alert>
      )}
      <RoomSettingsDialog
        room={room}
        tab={dialog === 'people' ? 'people' : 'general'}
        open={dialog === 'settings' || dialog === 'people'}
        onOpenChange={(o) => !o && setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        title={t('rooms.deleteTitle', { name: room.name })}
        text={t('rooms.deleteText')}
        action={t('rooms.delete')}
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
      />
    </header>
  )
}

/** The lock screen: enter (with the password when the room asks for one). */
function RoomGate({ room }: { room: Room }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [settings, setSettings] = useState(false)
  const Icon = room.needsPassword ? KeyRoundIcon : accessIcons[room.access]

  const enter = useMutation({
    mutationFn: () => api.enterRoom(orgId, room.id, password),
    onSuccess: (entered) => {
      setPassword('')
      qc.setQueryData(queryKeys.room(orgId, room.id), entered)
      void qc.invalidateQueries({ queryKey: queryKeys.rooms(orgId) })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    enter.mutate()
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <Icon className="size-6" />
        </span>
        <h1 className="mt-4 text-xl font-bold tracking-tight">{room.name}</h1>
        <div className="mt-2 flex justify-center">
          <AccessBadge access={room.access} />
        </div>
        {room.topic && <p className="mt-3 text-[13px] text-muted-foreground">{room.topic}</p>}

        {!room.canEnter ? (
          <>
            <p className="mt-5 text-[13px] text-muted-foreground">{t('rooms.notAllowed')}</p>
            {room.canManage && (
              <Button variant="outline" className="mt-4" onClick={() => setSettings(true)}>
                <SettingsIcon />
                {t('rooms.settings')}
              </Button>
            )}
          </>
        ) : (
          <form className="mt-5 grid gap-3 text-left" onSubmit={submit}>
            <p className="text-center text-[13px] text-muted-foreground">
              {room.needsPassword
                ? t('rooms.lockedText', { time: formatMinutes(room.admissionMinutes) })
                : t('rooms.enterText')}
            </p>
            {enter.error && <Alert variant="error">{errorMessage(enter.error)}</Alert>}
            {room.needsPassword && (
              <Field label={t('rooms.password')}>
                <Input
                  type="password"
                  autoFocus
                  autoComplete="off"
                  icon={<KeyRoundIcon />}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            )}
            <Button type="submit" disabled={enter.isPending || (room.needsPassword && !password)}>
              {t('rooms.enter')}
            </Button>
            {room.canManage && (
              <Button type="button" variant="ghost" onClick={() => setSettings(true)}>
                <SettingsIcon />
                {t('rooms.settings')}
              </Button>
            )}
          </form>
        )}
      </div>
      {room.canManage && <RoomSettingsDialog room={room} tab="general" open={settings} onOpenChange={setSettings} />}
    </div>
  )
}
