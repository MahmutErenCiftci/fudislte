import type { Board, BoardElement, BoardViewer } from '@fudislte/api-client'
import {
  Alert,
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  AudioLinesIcon,
  CheckIcon,
  EllipsisIcon,
  FolderKanbanIcon,
  PencilIcon,
  PenToolIcon,
  Share2Icon,
  Trash2Icon,
} from 'lucide-react'
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { useShell, useWorkspace } from '../../shell/context'
import { ConfirmDialog } from '../chat/ChannelDialogs'
import { usePresenceMap } from '../presence/presence'
import { ProjectIcon } from '../projects/projects'
import { isInCall, joinVoice, useVoice } from '../voice/voice'
import { BoardDialog } from './BoardDialog'
import { onBoardEvent } from './live'
import { newClientId, personColor } from './sync'

const BoardCanvas = lazy(() => import('./BoardCanvas'))

const HEARTBEAT_MS = 10_000
const EDITING_MS = 5_000

/** /w/:slug/b/:boardId — a whiteboard (mockup "Yeni 08"). */
export function BoardPage() {
  const t = useT()
  const { boardId = '' } = useParams()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  // The scene is read once per visit; later changes arrive as events.
  const scene = useQuery({
    queryKey: queryKeys.board(orgId, boardId),
    queryFn: () => api.board(orgId, boardId),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  if (scene.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }
  if (!scene.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-[14px] text-muted-foreground">{t('boards.notFound')}</p>
        <Button variant="outline" asChild>
          <Link to={`/w/${workspace.organization.slug}/boards`}>{t('boards.back')}</Link>
        </Button>
      </div>
    )
  }
  return <BoardView key={scene.data.board.id} board={scene.data.board} elements={scene.data.elements} />
}

function BoardView({ board: initial, elements }: { board: Board; elements: BoardElement[] }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [board, setBoard] = useState(initial)
  const [clientId] = useState(newClientId)
  const [viewers, setViewers] = useState<BoardViewer[]>([])
  const [editing, setEditing] = useState<Record<string, number>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const { setAsideTaken } = useShell()
  useEffect(() => {
    setAsideTaken(true)
    return () => setAsideTaken(false)
  }, [setAsideTaken])

  // Presence on the board: a heartbeat every 10 seconds; leaving removes the window.
  useEffect(() => {
    let stopped = false
    const beat = () =>
      api
        .boardHeartbeat(orgId, board.id, clientId)
        .then((list) => !stopped && setViewers(list))
        .catch(() => {})
    void beat()
    const timer = window.setInterval(beat, HEARTBEAT_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
      api.leaveBoard(orgId, board.id, clientId).catch(() => {})
    }
  }, [orgId, board.id, clientId])

  useEffect(
    () =>
      onBoardEvent((e) => {
        if (e.type === 'resync' || e.data.boardId !== board.id) return
        if (e.type === 'board.viewers') setViewers(e.data.viewers)
        if (e.type === 'board.deleted') setGone(true)
        if (e.type === 'board.updated') {
          api
            .board(orgId, board.id)
            .then((s) => setBoard(s.board))
            .catch(() => {})
        }
      }),
    [orgId, board.id],
  )
  // Stable, so the memoized canvas does not re-render when someone edits.
  const markEdit = useCallback((userId: string) => setEditing((m) => ({ ...m, [userId]: Date.now() })), [])

  if (gone) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-[14px] text-muted-foreground">{t('boards.deleted')}</p>
        <Button variant="outline" asChild>
          <Link to={`/w/${workspace.organization.slug}/boards`}>{t('boards.back')}</Link>
        </Button>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardHeader
        board={board}
        viewers={viewers}
        onSaved={(b) => setBoard(b)}
        onDeleted={() => {
          qc.removeQueries({ queryKey: queryKeys.board(orgId, board.id) })
          void qc.invalidateQueries({ queryKey: queryKeys.boards(orgId) })
          navigate(`/w/${workspace.organization.slug}/boards`)
        }}
      />
      {problem && (
        <div className="px-6 pb-2">
          <Alert variant="error">{problem}</Alert>
        </div>
      )}
      {!board.canEdit && <p className="px-6 pb-2 text-[13px] text-muted-foreground">{t('boards.readOnly')}</p>}
      <div className="flex min-h-0 flex-1 gap-3 px-6 pb-6">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-white dark:bg-[#121212]">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Spinner label={t('boards.loadingCanvas')} />
              </div>
            }
          >
            <BoardCanvas board={board} initialElements={elements} clientId={clientId} onEdit={markEdit} onProblem={setProblem} />
          </Suspense>
        </div>
        <BoardAside board={board} viewers={viewers} editing={editing} />
      </div>
    </div>
  )
}

function BoardHeader({
  board,
  viewers,
  onSaved,
  onDeleted,
}: {
  board: Board
  viewers: BoardViewer[]
  onSaved: (b: Board) => void
  onDeleted: () => void
}) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null)
  const [copied, setCopied] = useState(false)
  const remove = useMutation({ mutationFn: () => api.deleteBoard(orgId, board.id), onSuccess: onDeleted })
  const copyLink = () =>
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  return (
    <header className="shrink-0 px-6 pt-4 pb-3">
      <Link
        to={`/w/${workspace.organization.slug}/boards`}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('boards.back')}
      </Link>
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
          <PenToolIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">{board.title}</h1>
          <p className="mt-1 truncate text-[14px] text-muted-foreground">{board.description || t('boards.liveHint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex -space-x-1.5">
            {viewers.slice(0, 5).map((v) => (
              <Avatar key={v.user.id} name={v.user.displayName} seed={v.user.id} size="sm" className="ring-2 ring-card" title={v.user.displayName} />
            ))}
          </span>
          <Tooltip content={copied ? t('common.copied') : t('boards.copyLink')} side="bottom">
            <Button variant="outline" onClick={copyLink}>
              {copied ? <CheckIcon /> : <Share2Icon />}
              {t('projects.share')}
            </Button>
          </Tooltip>
          {(board.canEdit || board.canManage) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="size-9" aria-label={t('boards.options')}>
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {board.canEdit && (
                  <DropdownMenuItem onSelect={() => setDialog('edit')}>
                    <PencilIcon />
                    {t('boards.edit')}
                  </DropdownMenuItem>
                )}
                {board.canManage && (
                  <DropdownMenuItem variant="destructive" onSelect={() => setDialog('delete')}>
                    <Trash2Icon />
                    {t('boards.delete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      <BoardDialog open={dialog === 'edit'} onOpenChange={(o) => setDialog(o ? 'edit' : null)} board={board} onSaved={onSaved} />
      <ConfirmDialog
        open={dialog === 'delete'}
        title={t('boards.deleteTitle', { title: board.title })}
        text={t('boards.deleteText')}
        action={t('boards.delete')}
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
      />
    </header>
  )
}

/** Participants ("Düzenliyor" / "Beyaz tahtada"), the voice room and linked items. */
function BoardAside({ board, viewers, editing }: { board: Board; viewers: BoardViewer[]; editing: Record<string, number> }) {
  const t = useT()
  // "Düzenliyor" fades a few seconds after someone's last change.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const { me, workspace } = useWorkspace()
  const presence = usePresenceMap()
  const voice = useVoice()
  const root = `/w/${workspace.organization.slug}`
  const room = board.room
  const inCall = room ? isInCall(voice, 'room', room.id) : false
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto xl:flex">
      <AsideCard title={t('boards.participants', { count: viewers.length })}>
        <ul className="grid gap-2.5">
          {viewers.map((v) => {
            const isEditing = now - (editing[v.user.id] ?? 0) < EDITING_MS
            const color = personColor(v.user.id)
            return (
              <li key={v.user.id} className="flex items-center gap-2.5">
                <span className="rounded-full p-0.5" style={{ boxShadow: `0 0 0 2px ${color.stroke}` }}>
                  <Avatar name={v.user.displayName} seed={v.user.id} size="sm" online={presence.get(v.user.id)?.state === 'online'} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {v.user.displayName}
                    {v.user.id === me.user.id && <span className="ml-1 font-normal text-muted-foreground">{t('voice.you')}</span>}
                  </span>
                  <span className="block text-xs text-muted-foreground">{isEditing ? t('boards.editing') : t('boards.viewing')}</span>
                </span>
              </li>
            )
          })}
          {viewers.length === 0 && <li className="text-[13px] text-muted-foreground">{t('boards.nobody')}</li>}
        </ul>
      </AsideCard>
      {room && (
        <AsideCard title={t('boards.voiceRoom')}>
          <div className="grid gap-2">
            <Link to={`${root}/r/${room.id}`} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium hover:bg-accent/50">
              <AudioLinesIcon className="size-4 text-primary" />
              <span className="truncate">{room.name}</span>
            </Link>
            {room.joined ? (
              <Button
                size="sm"
                variant={inCall ? 'outline' : 'default'}
                disabled={inCall}
                onClick={() => void joinVoice({ kind: 'room', id: room.id, name: room.name, orgId: workspace.organization.id, slug: workspace.organization.slug })}
              >
                <AudioLinesIcon />
                {inCall ? t('voice.connected') : t('voice.join')}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t('boards.enterRoomFirst')}</p>
            )}
          </div>
        </AsideCard>
      )}
      <AsideCard title={t('boards.linked')}>
        <ul className="grid gap-2 text-[13px]">
          {board.project && (
            <li>
              <Link to={`${root}/p/${board.project.id}`} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-accent/50">
                <ProjectIcon project={board.project} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{board.project.name}</span>
                  <span className="block text-xs text-muted-foreground">{t('boards.projectLink')}</span>
                </span>
                <FolderKanbanIcon className="size-4 text-muted-foreground" />
              </Link>
            </li>
          )}
          {!board.project && !room && <li className="text-muted-foreground">{t('boards.noLinks')}</li>}
          {room && (
            <li className="flex items-center gap-2 px-1 py-1 text-muted-foreground">
              <AudioLinesIcon className="size-4" />
              {t('boards.roomLink', { name: room.name })}
            </li>
          )}
        </ul>
      </AsideCard>
    </aside>
  )
}

function AsideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="mb-3 text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  )
}
