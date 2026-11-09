import type { Member } from '@fudislte/api-client'
import { Avatar, cn, Dialog, DialogContent, DialogTitle, Kbd } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import {
  Building2Icon,
  CornerDownLeftIcon,
  FileTextIcon,
  FolderKanbanIcon,
  HouseIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  SearchIcon,
} from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { useT } from '../i18n'
import { ChannelIcon, useChannels } from '../features/chat/ChannelSidebar'
import { ConversationAvatar, useConversations } from '../features/chat/DirectMessages'
import { channelLabel, channelTitle } from '../features/chat/names'
import { resultLink, searchWords, useDebounced } from '../features/chat/SearchPage'
import { messagePreview } from '../features/chat/text'
import { useProjects } from '../features/projects/projects'
import { accessIcons, useRooms } from '../features/rooms/rooms'
import { visibleSettingsSections } from '../features/settings/sections'
import { api, queryKeys } from '../lib/api'
import { can } from '../lib/permissions'
import { useWorkspace } from './context'
import { MemberCard } from './MemberCard'
import { searchKey } from '../lib/search'

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  icon: ReactNode
  run: () => void
}

/**
 * "Her yerde ara": jumps to pages, channels, rooms, projects, people and workspaces, and
 * searches messages and tasks. Files join the results when that module ships.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const navigate = useNavigate()
  const orgId = workspace.organization.id
  const root = `/w/${workspace.organization.slug}`
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [person, setPerson] = useState<Member | null>(null)
  const channels = useChannels()
  const conversations = useConversations()
  const rooms = useRooms()
  const debounced = useDebounced(query.trim())
  const searchQuery = searchWords(debounced).length > 0 && debounced.length >= 2 ? debounced : ''
  const messages = useQuery({
    queryKey: queryKeys.search(orgId, searchQuery),
    queryFn: () => api.search(orgId, { q: searchQuery, limit: 5 }),
    enabled: open && searchQuery !== '',
  })
  const projects = useProjects(false, open)
  const tasks = useQuery({
    queryKey: queryKeys.taskSearch(orgId, searchQuery),
    queryFn: () => api.searchTasks(orgId, searchQuery),
    enabled: open && searchQuery !== '',
  })
  const members = useQuery({
    queryKey: queryKeys.members(orgId),
    queryFn: () => api.members(orgId),
    enabled: open && can(workspace, 'members.view'),
  })

  const close = () => {
    onOpenChange(false)
    setQuery('')
    setActive(0)
  }
  const go = (to: string) => () => {
    navigate(to)
    close()
  }

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      { id: 'home', group: t('palette.pages'), label: t('nav.home'), icon: <HouseIcon />, run: go(root) },
      ...visibleSettingsSections(workspace, me.user).map((s) => ({
        id: `settings-${s.path}`,
        group: t('palette.pages'),
        label: `${t('nav.settings')} · ${t(s.label)}`,
        hint: t(s.description),
        icon: <FileTextIcon />,
        run: go(`${root}/settings/${s.path}`),
      })),
      ...(channels.data ?? []).map((c) => ({
        id: `channel-${c.id}`,
        group: t('palette.channels'),
        label: `#${c.name}`,
        hint: c.topic || undefined,
        icon: <ChannelIcon channel={c} />,
        run: go(`${root}/c/${c.id}`),
      })),
      ...(conversations.data ?? []).map((c) => ({
        id: `conversation-${c.id}`,
        group: t('palette.conversations'),
        label: channelTitle(c, me.user.id, t),
        icon: <ConversationAvatar conversation={c} />,
        run: go(`${root}/c/${c.id}`),
      })),
      ...(rooms.data ?? []).map((r) => {
        const Icon = accessIcons[r.access]
        return {
          id: `room-${r.id}`,
          group: t('palette.rooms'),
          label: r.name,
          hint: r.topic || undefined,
          icon: <Icon />,
          run: go(`${root}/r/${r.id}`),
        }
      }),
      ...(projects.data ?? []).map((p) => ({
        id: `project-${p.id}`,
        group: t('palette.projects'),
        label: p.name,
        hint: p.key,
        icon: <FolderKanbanIcon />,
        run: go(`${root}/p/${p.id}`),
      })),
      ...(members.data ?? []).map((m) => ({
        id: `person-${m.user.id}`,
        group: t('palette.people'),
        label: m.user.displayName,
        hint: `${m.role.name} · ${m.user.email}`,
        icon: <Avatar name={m.user.displayName} seed={m.user.id} size="xs" />,
        run: () => setPerson(m),
      })),
      ...me.workspaces
        .filter((w) => w.organization.id !== orgId)
        .map((w) => ({
          id: `ws-${w.organization.id}`,
          group: t('palette.workspaces'),
          label: w.organization.name,
          hint: w.role.name,
          icon: <Building2Icon />,
          run: go(`/w/${w.organization.slug}`),
        })),
    ]
    const q = searchKey(query.trim())
    const matches = q ? all.filter((i) => searchKey(`${i.label} ${i.hint ?? ''}`).includes(q)) : all
    if (!searchQuery) return matches
    // Messages come from the server's full-text search, so they are not filtered again.
    const found: Item[] = (messages.data ?? []).map((r) => ({
      id: `message-${r.message.id}`,
      group: t('palette.messages'),
      label: messagePreview(r.message),
      hint: `${r.message.author?.displayName ?? t('chat.deletedUser')} · ${
        r.channel ? channelLabel(r.channel, me.user.id, t) : ''
      }`,
      icon: <MessageSquareTextIcon />,
      run: go(resultLink(workspace.organization.slug, r)),
    }))
    const everything: Item = {
      id: 'search-all',
      group: t('palette.messages'),
      label: t('palette.searchAll', { query: searchQuery }),
      icon: <SearchIcon />,
      run: go(`${root}/search?q=${encodeURIComponent(searchQuery)}`),
    }
    // Tasks come from the server too: titles and keys ("ENG-42") of projects the caller may see.
    const tasksFound: Item[] = (tasks.data ?? []).map((task) => ({
      id: `task-${task.id}`,
      group: t('palette.tasks'),
      label: task.title,
      hint: `${task.key} · ${task.status.name}`,
      icon: <ListChecksIcon />,
      run: go(`${root}/p/${task.project.id}?task=${task.id}`),
    }))
    return [...matches, ...tasksFound, ...found, everything]
  }, [query, searchQuery, messages.data, tasks.data, channels.data, conversations.data, rooms.data, projects.data, members.data, me.user.id, me.workspaces, workspace, root, orgId, t])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[active]?.run()
    }
  }

  let lastGroup = ''
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
        <DialogContent className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl [&>button:last-child]:hidden">
          <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
          <div className="flex items-center gap-2 border-b px-4">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              aria-label={t('palette.title')}
              placeholder={t('palette.placeholder')}
              className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
            />
            <Kbd>Esc</Kbd>
          </div>
          <div role="listbox" aria-label={t('palette.results')} className="max-h-96 overflow-y-auto p-2">
            {items.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">{t('palette.empty')}</p>}
            {items.map((item, i) => {
              const header = item.group !== lastGroup ? item.group : null
              lastGroup = item.group
              return (
                <div key={item.id}>
                  {header && <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{header}</p>}
                  <button
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={item.run}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-[13px] outline-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
                      i === active && 'bg-primary-soft text-primary-soft-foreground',
                    )}
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.label}</span>
                      {item.hint && <span className="block truncate text-xs text-muted-foreground">{item.hint}</span>}
                    </span>
                    {i === active && <CornerDownLeftIcon className="size-3.5 shrink-0 opacity-60" />}
                  </button>
                </div>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={person !== null} onOpenChange={(o) => !o && setPerson(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle className="sr-only">{t('palette.profile')}</DialogTitle>
          {person && (
            <MemberCard
              member={person}
              onNavigate={() => {
                setPerson(null)
                close()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
