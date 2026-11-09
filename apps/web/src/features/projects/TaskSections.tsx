import type { TaskDetail } from '@fudislte/api-client'
import {
  Avatar,
  Button,
  Checkbox,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AudioLinesIcon, HashIcon, LinkIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { useWorkspace } from '../../shell/context'
import { useChannels } from '../chat/ChannelSidebar'
import { MessageText } from '../chat/MessageText'
import { useRooms } from '../rooms/rooms'
import { describeActivity } from './activity'
import { taskSaved } from './cache'
import { formatDueDate } from './projects'

/** Runs a task change and puts the answer into the cache. */
function useTaskChange(task: TaskDetail) {
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (run: (orgId: string, projectId: string, taskId: string) => Promise<TaskDetail>) => run(orgId, task.project.id, task.id),
    onSuccess: (saved) => taskSaved(qc, orgId, saved),
  })
}

export function Checklist({ task, editable }: { task: TaskDetail; editable: boolean }) {
  const t = useT()
  const change = useTaskChange(task)
  const [text, setText] = useState('')
  const id = useId()
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    change.mutate((o, p, k) => api.addChecklistItem(o, p, k, text), { onSuccess: () => setText('') })
  }
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h3 id={id} className="flex items-center gap-2 text-[13px] font-semibold">
        {t('tasks.checklist')}
        {task.checklistItems.length > 0 && (
          <span className="font-normal text-muted-foreground">
            {task.checklist.done}/{task.checklist.total}
          </span>
        )}
      </h3>
      <ul className="grid gap-1">
        {task.checklistItems.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent/50">
            <Checkbox
              checked={item.done}
              disabled={!editable}
              aria-label={item.text}
              onCheckedChange={(v) => change.mutate((o, p, k) => api.updateChecklistItem(o, p, k, item.id, { done: v === true }))}
            />
            <span className={cn('flex-1 text-[13px]', item.done && 'text-muted-foreground line-through')}>{item.text}</span>
            {editable && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t('tasks.removeItem', { text: item.text })}
                onClick={() => change.mutate((o, p, k) => api.deleteChecklistItem(o, p, k, item.id))}
              >
                <XIcon />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form onSubmit={add} className="flex gap-2">
          <Input
            className="h-8 text-[13px]"
            maxLength={200}
            placeholder={t('tasks.addItem')}
            aria-label={t('tasks.addItem')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!text.trim() || change.isPending}>
            <PlusIcon />
          </Button>
        </form>
      )}
      {change.error && <p className="text-xs text-destructive">{errorMessage(change.error)}</p>}
    </section>
  )
}

export function Comments({ task, editable, canModerate }: { task: TaskDetail; editable: boolean; canModerate: boolean }) {
  const t = useT()
  const { me } = useWorkspace()
  const change = useTaskChange(task)
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const send = (e: FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    change.mutate((o, p, k) => api.addTaskComment(o, p, k, body), { onSuccess: () => setBody('') })
  }
  const saveEdit = () => {
    if (!editing) return
    const { id, body: text } = editing
    change.mutate((o, p, k) => api.editTaskComment(o, p, k, id, text), { onSuccess: () => setEditing(null) })
  }
  return (
    <div className="grid gap-3">
      {task.comments.length === 0 && <p className="text-[13px] text-muted-foreground">{t('tasks.noComments')}</p>}
      <ul className="grid gap-3">
        {task.comments.map((c) => {
          const mine = c.author?.id === me.user.id
          return (
            <li key={c.id} className="flex gap-2.5">
              <Avatar name={c.author?.displayName ?? '?'} seed={c.author?.id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-xs">
                  <span className="font-semibold">{c.author?.displayName ?? t('audit.deletedUser')}</span>
                  <span className="text-muted-foreground">{formatRelative(c.createdAt)}</span>
                  {c.editedAt && <span className="text-muted-foreground">{t('chat.edited')}</span>}
                  {editable && mine && editing?.id !== c.id && (
                    <Button variant="ghost" size="icon-sm" className="ml-auto size-6" aria-label={t('tasks.editComment')} onClick={() => setEditing({ id: c.id, body: c.body })}>
                      <PencilIcon className="size-3.5" />
                    </Button>
                  )}
                  {editable && (mine || canModerate) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn('size-6', !(mine && editing?.id !== c.id) && 'ml-auto')}
                      aria-label={t('tasks.deleteComment')}
                      onClick={() => change.mutate((o, p, k) => api.deleteTaskComment(o, p, k, c.id))}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  )}
                </p>
                {editing?.id === c.id ? (
                  <div className="mt-1 grid gap-2">
                    <Textarea rows={3} maxLength={4000} value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                        {t('common.cancel')}
                      </Button>
                      <Button size="sm" onClick={saveEdit} disabled={!editing.body.trim() || change.isPending}>
                        {t('common.save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-0.5 text-[13px]">
                    <MessageText body={c.body} />
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {editable && (
        <form onSubmit={send} className="grid gap-2">
          <Textarea
            rows={2}
            maxLength={4000}
            placeholder={t('tasks.commentPlaceholder')}
            aria-label={t('tasks.commentPlaceholder')}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e)
            }}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!body.trim() || change.isPending}>
              {t('tasks.comment')}
            </Button>
          </div>
        </form>
      )}
      {change.error && <p className="text-xs text-destructive">{errorMessage(change.error)}</p>}
    </div>
  )
}

export function Activity({ task }: { task: TaskDetail }) {
  const t = useT()
  return (
    <ul className="grid gap-3">
      {task.activity.map((e) => (
        <li key={e.id} className="flex gap-2.5 text-[13px]">
          <Avatar name={e.actor?.displayName ?? '?'} seed={e.actor?.id} size="xs" className="mt-0.5" />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">{e.actor?.displayName ?? t('audit.deletedUser')}</span> {describeActivity(e, (d) => formatDueDate(d, true))}
            <span className="ml-2 text-xs text-muted-foreground">{formatRelative(e.createdAt)}</span>
          </p>
        </li>
      ))}
    </ul>
  )
}

/** Channels and rooms the task is linked to, and a picker to link more. */
export function Links({ task, editable }: { task: TaskDetail; editable: boolean }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const root = `/w/${workspace.organization.slug}`
  const change = useTaskChange(task)
  const channels = useChannels()
  const rooms = useRooms()
  const linked = new Set(task.links.map((l) => l.id))
  const candidates = [
    ...(rooms.data ?? []).filter((r) => r.admitted).map((r) => ({ id: r.id, kind: 'room' as const, name: r.name })),
    ...(channels.data ?? []).map((c) => ({ id: c.id, kind: 'channel' as const, name: c.name })),
  ].filter((c) => !linked.has(c.id))
  return (
    <div className="grid gap-1.5">
      <ul className="grid gap-1">
        {task.links.map((l) => {
          const Icon = l.kind === 'room' ? AudioLinesIcon : HashIcon
          return (
            <li key={l.id} className="group flex items-center gap-2 text-[13px]">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <Link to={`${root}/${l.kind === 'room' ? 'r' : 'c'}/${l.id}`} className="min-w-0 flex-1 truncate hover:underline">
                {l.name}
              </Link>
              {editable && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t('tasks.unlink', { name: l.name })}
                  onClick={() => change.mutate((o, p, k) => api.unlinkTask(o, p, k, l.id))}
                >
                  <XIcon className="size-3.5" />
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {task.links.length === 0 && <p className="text-xs text-muted-foreground">{t('tasks.noLinks')}</p>}
      {editable && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="justify-start">
              <LinkIcon />
              {t('tasks.link')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="grid max-h-72 w-64 gap-0.5 overflow-y-auto p-1.5">
            {candidates.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t('tasks.linkNone')}</p>}
            {candidates.map((c) => {
              const Icon = c.kind === 'room' ? AudioLinesIcon : HashIcon
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => change.mutate((o, p, k) => api.linkTask(o, p, k, c.id))}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{c.name}</span>
                </button>
              )
            })}
          </PopoverContent>
        </Popover>
      )}
      {change.error && <p className="text-xs text-destructive">{errorMessage(change.error)}</p>}
    </div>
  )
}
