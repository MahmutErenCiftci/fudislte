// Loaded lazily (React.lazy): Excalidraw is large and only boards need it.
import './excalidraw-assets'
import '@excalidraw/excalidraw/index.css'
import './board.css'

import { CaptureUpdateAction, Excalidraw, MainMenu } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types'
import { ApiError, type Board, type BoardElement, type LiveEvents } from '@fudislte/api-client'
import { getPlatform } from '@fudislte/platform'
import { memo, useEffect, useRef, useState } from 'react'

import { t, useLanguage } from '../../i18n'
import { api } from '../../lib/api'
import { useTheme } from '../../lib/theme'
import { useWorkspace } from '../../shell/context'
import { onBoardEvent } from './live'
import { batches, mergeElements, pendingChanges, personColor, SYNCED_TYPES } from './sync'

const SEND_EVERY_MS = 100

function isSameOrigin(link: string): boolean {
  try {
    return new URL(link, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}
const CURSOR_EVERY_MS = 80
const CURSOR_TTL_MS = 15_000

interface Props {
  board: Board
  initialElements: BoardElement[]
  clientId: string
  /** Someone's edit reached this window (for "Düzenliyor"). */
  onEdit: (userId: string) => void
  /** Saving failed for good, e.g. the board is full; null clears the message. */
  onProblem: (message: string | null) => void
}

type Cursor = Collaborator & { seen: number }

/**
 * The Excalidraw scene of a board, kept in sync with the server: local changes are sent
 * in batches every ~100 ms, accepted remote elements are merged with the same rule the
 * server applies, cursors are relayed, and a reconnect merges the stored scene again.
 */
function BoardCanvas({ board, initialElements, clientId, onEdit, onProblem }: Props) {
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const language = useLanguage()
  const theme = useTheme()
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const canEdit = board.canEdit
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  // The version of each element last sent or received: anything newer is a local change.
  const synced = useRef(new Map(initialElements.map((e) => [e.id, e.version])))
  const buffered = useRef<LiveEvents['board.elements'][]>([])
  const cursors = useRef(new Map<string, Cursor>())
  // The scene is loaded once; later changes arrive as events.
  const [initialData] = useState(() => ({ elements: initialElements as unknown as ExcalidrawElement[], scrollToContent: true }))

  // Sending: one request at a time, at most every SEND_EVERY_MS, retried with backoff.
  const sender = useRef({ timer: 0, inflight: false, again: false, retryMs: 0 })
  const schedule = () => {
    const s = sender.current
    if (s.timer) return
    s.timer = window.setTimeout(() => {
      s.timer = 0
      void flush()
    }, s.retryMs || SEND_EVERY_MS)
  }
  const flush = async () => {
    const s = sender.current
    const excalidraw = apiRef.current
    if (!excalidraw || !canEdit) return
    if (s.inflight) {
      s.again = true
      return
    }
    const changes = pendingChanges(excalidraw.getSceneElementsIncludingDeleted() as unknown as BoardElement[], synced.current)
    if (changes.length === 0) return
    const before = new Map(changes.map((e) => [e.id, synced.current.get(e.id)]))
    for (const e of changes) synced.current.set(e.id, e.version)
    s.inflight = true
    try {
      for (const batch of batches(changes)) await api.saveBoardElements(orgId, board.id, clientId, batch)
      s.retryMs = 0
      onProblem(null)
      onEdit(me.user.id)
    } catch (err) {
      if (err instanceof ApiError && [403, 404, 409, 413, 422].includes(err.status)) {
        // Not worth repeating: the board is full, gone, or no longer editable.
        onProblem(err.message)
      } else {
        for (const [id, v] of before) {
          if (v === undefined) synced.current.delete(id)
          else synced.current.set(id, v)
        }
        s.retryMs = Math.min(Math.max(s.retryMs * 2, 1000), 30_000)
        s.again = true
      }
    } finally {
      s.inflight = false
      if (s.again) {
        s.again = false
        schedule()
      }
    }
  }

  const applyRemote = (ev: LiveEvents['board.elements']) => {
    const excalidraw = apiRef.current
    if (!excalidraw) {
      buffered.current.push(ev)
      return
    }
    merge(excalidraw, ev.elements)
    if (ev.user.id !== me.user.id) onEdit(ev.user.id)
  }
  const merge = (excalidraw: ExcalidrawImperativeAPI, remote: BoardElement[]) => {
    const state = excalidraw.getAppState()
    const keep = new Set([state.editingTextElement?.id, state.newElement?.id, state.resizingElement?.id].filter((x): x is string => !!x))
    const local = excalidraw.getSceneElementsIncludingDeleted() as unknown as BoardElement[]
    const { elements, taken } = mergeElements(local, remote, keep)
    if (taken.length === 0) return
    for (const e of taken) synced.current.set(e.id, e.version)
    excalidraw.updateScene({ elements: elements as unknown as ExcalidrawElement[], captureUpdate: CaptureUpdateAction.NEVER })
  }
  const showCursors = () => {
    const now = Date.now()
    for (const [key, c] of cursors.current) if (now - c.seen > CURSOR_TTL_MS) cursors.current.delete(key)
    apiRef.current?.updateScene({ collaborators: new Map([...cursors.current].map(([k, c]) => [k as SocketId, c])) })
  }

  useEffect(() => {
    const resync = async () => {
      try {
        const scene = await api.board(orgId, board.id, true)
        if (apiRef.current) merge(apiRef.current, scene.elements)
      } catch {
        // The next event or reconnect tries again.
      }
    }
    const off = onBoardEvent((e) => {
      if (e.type === 'resync') return void resync()
      if (e.data.boardId !== board.id) return
      if (e.type === 'board.elements' && e.data.clientId !== clientId) applyRemote(e.data)
      if (e.type === 'board.cursor' && e.data.user.id !== me.user.id) {
        const d = e.data
        cursors.current.set(d.clientId, {
          id: d.user.id,
          socketId: d.clientId as SocketId,
          username: d.user.displayName,
          color: personColor(d.user.id),
          pointer: d.pointer,
          button: d.button,
          selectedElementIds: Object.fromEntries(d.selectedElementIds.map((id) => [id, true])),
          seen: Date.now(),
        })
        showCursors()
      }
      if (e.type === 'board.viewers') {
        const here = new Set(e.data.viewers.map((v) => v.user.id))
        for (const [key, c] of cursors.current) if (c.id && !here.has(c.id)) cursors.current.delete(key)
        showCursors()
      }
    })
    const sweep = window.setInterval(showCursors, 5000)
    return () => {
      off()
      window.clearInterval(sweep)
      window.clearTimeout(sender.current.timer)
      void flush() // last changes on the way out
    }
  }, [board.id, clientId, orgId])

  // Cursor: throttled, unchanged positions are not sent.
  const lastCursor = useRef({ at: 0, key: '' })
  const onPointerUpdate = (payload: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' }; button: 'down' | 'up' }) => {
    const now = Date.now()
    const x = Math.round(payload.pointer.x)
    const y = Math.round(payload.pointer.y)
    const key = `${x},${y},${payload.pointer.tool},${payload.button}`
    if (now - lastCursor.current.at < CURSOR_EVERY_MS || key === lastCursor.current.key) return
    lastCursor.current = { at: now, key }
    const selected = Object.keys(apiRef.current?.getAppState().selectedElementIds ?? {}).slice(0, 200)
    api
      .boardCursor(orgId, board.id, { clientId, x, y, tool: payload.pointer.tool, button: payload.button, selectedElementIds: selected })
      .catch(() => {})
  }

  const onChange = (elements: readonly ExcalidrawElement[]) => {
    if (!canEdit) return
    // Images and embeds are not stored or shared: take them off the canvas again.
    const unsupported = elements.some((e) => !e.isDeleted && !SYNCED_TYPES.has(e.type))
    if (unsupported) {
      apiRef.current?.updateScene({
        elements: elements.filter((e) => SYNCED_TYPES.has(e.type)),
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      apiRef.current?.setToast({ message: t('boards.unsupported'), duration: 4000 })
      return
    }
    schedule()
  }

  return (
    <div className="fudislte-board h-full">
      <Excalidraw
        excalidrawAPI={(excalidraw) => {
          apiRef.current = excalidraw
          for (const ev of buffered.current.splice(0)) applyRemote(ev)
        }}
        initialData={initialData}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        isCollaborating
        viewModeEnabled={!canEdit}
        theme={dark ? 'dark' : 'light'}
        langCode={language === 'tr' ? 'tr-TR' : 'en'}
        name={board.title}
        validateEmbeddable={false}
        onLinkOpen={(element, event) => {
          // Excalidraw opens a link "in place" when it merely contains this site's address,
          // so a shape could replace the app with a look-alike page. Only links that really
          // point here stay in the tab; every other one opens outside (a new tab, or the
          // system browser in the desktop app).
          if (element.link && !isSameOrigin(element.link)) {
            event.preventDefault()
            void getPlatform().openExternal(element.link).catch(() => {})
          }
        }}
        onPaste={(data) => {
          if (data.files && Object.keys(data.files).length > 0) {
            apiRef.current?.setToast({ message: t('boards.unsupported'), duration: 4000 })
            return false
          }
          return true
        }}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            toggleTheme: null,
            clearCanvas: canEdit,
            changeViewBackgroundColor: canEdit,
            saveAsImage: true,
          },
          tools: { image: false },
        }}
      >
        {/* Only local actions: no file loading, social links, collaboration server or Excalidraw+. */}
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          {canEdit && <MainMenu.DefaultItems.ClearCanvas />}
          {canEdit && <MainMenu.Separator />}
          {canEdit && <MainMenu.DefaultItems.ChangeCanvasBackground />}
        </MainMenu>
      </Excalidraw>
    </div>
  )
}

// Memoized: the board page re-renders when people edit or come and go, and Excalidraw
// should not re-render with it.
export default memo(BoardCanvas)
