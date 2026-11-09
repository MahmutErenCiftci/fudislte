import type { Task } from '@fudislte/api-client'
import { Button, Checkbox, cn, Input, Popover, PopoverContent, PopoverTrigger, Spinner } from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListChecksIcon, PlusIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { useDebounced } from '../chat/SearchPage'
import { taskSaved } from './cache'
import { Assignees, StatusDot, useProjectLinks, useToggleDone } from './projects'

/**
 * "Bağlantılı Görevler" on a room's page (mockup "Yeni 05"): tasks linked to the room
 * that the viewer may see, ticked off in place, and a search to link more.
 */
export function LinkedTasks({ channelId }: { channelId: string }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const links = useProjectLinks()
  const [expanded, setExpanded] = useState(false)
  const tasks = useQuery({ queryKey: queryKeys.channelTasks(orgId, channelId), queryFn: () => api.channelTasks(orgId, channelId) })
  const done = useToggleDone()
  const list = tasks.data ?? []
  const shown = expanded ? list : list.slice(0, 3)

  return (
    <section aria-labelledby={`linked-${channelId}`} className="mx-6 mt-3 rounded-xl border bg-card">
      <header className="flex items-center gap-2 px-4 py-2.5">
        <ListChecksIcon className="size-4 text-primary" />
        <h2 id={`linked-${channelId}`} className="text-[13px] font-semibold">
          {t('linked.title')}
        </h2>
        <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{list.length}</span>
        <span className="ml-auto">
          <LinkTaskButton channelId={channelId} linked={list.map((x) => x.id)} />
        </span>
      </header>
      {tasks.isPending && (
        <div className="flex justify-center pb-3">
          <Spinner />
        </div>
      )}
      {tasks.error && <p className="px-4 pb-3 text-xs text-destructive">{errorMessage(tasks.error)}</p>}
      {done.error && <p className="px-4 pb-2 text-xs text-destructive">{errorMessage(done.error)}</p>}
      {tasks.data && list.length === 0 && <p className="px-4 pb-3 text-xs text-muted-foreground">{t('linked.empty')}</p>}
      {shown.length > 0 && (
        <ul className="divide-y border-t">
          {shown.map((task) => {
            const isDone = task.status.category === 'done'
            return (
              <li key={task.id} className="flex items-center gap-3 px-4 py-2">
                <Checkbox
                  checked={isDone}
                  aria-label={isDone ? t('linked.reopen', { title: task.title }) : t('linked.complete', { title: task.title })}
                  disabled={done.isPending}
                  onCheckedChange={() => done.mutate(task)}
                />
                <Link to={links.task(task.project.id, task.id)} className="min-w-0 flex-1 outline-none hover:underline focus-visible:underline">
                  <span className={cn('block truncate text-[13px]', isDone && 'text-muted-foreground line-through')}>{task.title}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot color={task.status.color} className="size-2" />
                    <span className="font-mono">#{task.key}</span>
                  </span>
                </Link>
                <Assignees people={task.assignees} max={2} />
              </li>
            )
          })}
        </ul>
      )}
      {list.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full border-t px-4 py-2 text-center text-xs font-medium text-primary outline-none hover:underline focus-visible:underline"
        >
          {expanded ? t('linked.showLess') : t('linked.showAll', { count: list.length })}
        </button>
      )}
    </section>
  )
}

/** Finds a task by title or key and links it to the channel or room. */
function LinkTaskButton({ channelId, linked }: { channelId: string; linked: string[] }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim())
  const results = useQuery({
    queryKey: queryKeys.taskSearch(orgId, q),
    queryFn: () => api.searchTasks(orgId, q),
    enabled: open && q.length >= 2,
  })
  const link = useMutation({
    mutationFn: (task: Task) => api.linkTask(orgId, task.project.id, task.id, channelId),
    onSuccess: (saved) => {
      taskSaved(qc, orgId, saved)
      void qc.invalidateQueries({ queryKey: queryKeys.channelTasks(orgId, channelId) })
      setOpen(false)
      setQuery('')
    },
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('linked.add')}>
          <PlusIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 gap-2 p-2">
        <Input
          autoFocus
          icon={<SearchIcon />}
          aria-label={t('linked.search')}
          placeholder={t('linked.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {link.error && <p className="px-1 text-xs text-destructive">{errorMessage(link.error)}</p>}
        <ul className="grid max-h-64 gap-0.5 overflow-y-auto">
          {q.length < 2 && <li className="px-2 py-1.5 text-xs text-muted-foreground">{t('linked.searchHint')}</li>}
          {results.data?.length === 0 && <li className="px-2 py-1.5 text-xs text-muted-foreground">{t('linked.noResults')}</li>}
          {results.data
            ?.filter((x) => !linked.includes(x.id))
            .map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  disabled={link.isPending}
                  onClick={() => link.mutate(task)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <StatusDot color={task.status.color} />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">{task.key}</span>
                </button>
              </li>
            ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
