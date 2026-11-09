import { Button, cn, Kbd, Tooltip } from '@fudislte/ui'
import { SearchIcon, UsersIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'

import { useT } from '../i18n'
import { BrandMark } from '../features/auth/AuthLayout'
import { ChannelSidebar } from '../features/chat/ChannelSidebar'
import { DirectMessagesSidebar, useConversations } from '../features/chat/DirectMessages'
import { useLiveEvents } from '../features/chat/useLiveEvents'
import { setNotificationTarget } from '../features/notifications/desktop'
import { NotificationBell } from '../features/notifications/NotificationBell'
import { can } from '../lib/permissions'
import { CommandPalette } from './CommandPalette'
import { ShellContext, usePersistentState, useWorkspace } from './context'
import { MemberPanel } from './MemberPanel'
import { useRooms } from '../features/rooms/rooms'
import { DisplayPicker } from '../features/voice/DisplayPicker'
import { VoiceDock } from '../features/voice/VoiceDock'
import { primaryNav } from './navigation'
import { UserMenu } from './UserMenu'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Application frame: top bar (brand, search, people toggle, account), sidebar
 * (workspace card, navigation, channels, direct messages) and a content panel with the optional people
 * list. It also holds the live event stream for the signed-in user.
 */
export function AppShell() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const canSeeMembers = can(workspace, 'members.view')
  useLiveEvents(me.user.id)
  const navigate = useNavigate()
  const location = useLocation()
  // Clicking a desktop notification opens its conversation, in whichever workspace.
  useEffect(() => {
    setNotificationTarget((orgId, channelId, threadId) => {
      const ws = me.workspaces.find((w) => w.organization.id === orgId)
      if (ws) navigate(`/w/${ws.organization.slug}/c/${channelId}${threadId ? `?thread=${threadId}` : ''}`)
    })
    return () => setNotificationTarget(null)
  }, [me.workspaces, navigate])
  const conversations = useConversations()
  const directUnread = (conversations.data ?? []).reduce((sum, c) => sum + c.unreadCount, 0)
  const rooms = useRooms()
  const roomsUnread = (rooms.data ?? []).reduce((sum, r) => sum + (r.admitted ? r.unreadCount : 0), 0)
  const badges: Record<string, number> = { messages: directUnread, rooms: roomsUnread }
  const [memberPanelOpen, setMemberPanelOpen] = usePersistentState('fudislte.memberPanel', true)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [asideTaken, setAsideTaken] = useState(false)
  const root = `/w/${workspace.organization.slug}`
  // The shell re-renders on every unread change; its consumers should not.
  const shell = useMemo(
    () => ({ canSeeMembers, memberPanelOpen, toggleMemberPanel: () => setMemberPanelOpen(!memberPanelOpen), setAsideTaken }),
    [canSeeMembers, memberPanelOpen, setMemberPanelOpen],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 px-4">
          <Link to={root} className="flex w-60 shrink-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <BrandMark className="size-8" />
            <span className="text-lg font-bold tracking-tight">FUDISLTE</span>
          </Link>
          <div className="flex flex-1 justify-center">
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border bg-card px-3 text-[13px] text-muted-foreground shadow-[var(--shadow-panel)] outline-none hover:border-input focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <SearchIcon className="size-4" />
              <span className="flex-1 text-left">{t('shell.search')}</span>
              <Kbd>{isMac ? '⌘' : 'Ctrl'} K</Kbd>
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            {canSeeMembers && (
              <Tooltip content={memberPanelOpen ? t('shell.hidePeople') : t('shell.showPeople')} side="bottom">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('shell.peopleToggle')}
                  aria-pressed={memberPanelOpen}
                  className={cn('size-9', memberPanelOpen ? 'text-foreground' : 'text-muted-foreground')}
                  onClick={() => setMemberPanelOpen(!memberPanelOpen)}
                >
                  <UsersIcon className="size-[18px]" />
                </Button>
              </Tooltip>
            )}
            <NotificationBell />
            <UserMenu />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
          <nav aria-label={t('nav.main')} className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto px-1">
            <WorkspaceSwitcher />
            <ul className="grid gap-0.5">
              {primaryNav
                .filter((item) => item.visible?.(workspace) ?? true)
                .map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path ? `${root}/${item.path}` : root}
                      end={item.path === ''}
                      className={({ isActive: active }) => {
                        // A room page belongs to Rooms in the menu, a meeting page to Meetings,
                        // a project page to Projects and a board to the whiteboards.
                        const under = (prefix: string) => location.pathname.startsWith(`${root}/${prefix}/`)
                        const isActive =
                          active ||
                          (item.path === 'rooms' && under('r')) ||
                          (item.path === 'meetings' && under('m')) ||
                          (item.path === 'projects' && under('p')) ||
                          (item.path === 'boards' && under('b'))
                        return cn(
                          'relative flex h-9 items-center gap-3 rounded-lg px-3 text-[14px] font-medium text-foreground/75 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                          isActive &&
                            'bg-primary-soft text-primary-soft-foreground before:absolute before:top-1.5 before:-left-1 before:h-6 before:w-[3px] before:rounded-full before:bg-primary hover:bg-primary-soft hover:text-primary-soft-foreground',
                        )
                      }}
                    >
                      <item.icon className="size-[18px]" />
                      <span className="flex-1">{t(item.label)}</span>
                      {(badges[item.path] ?? 0) > 0 && (
                        <span
                          aria-label={t('chat.unread', { count: badges[item.path] ?? 0 })}
                          className="rounded-full bg-primary px-1.5 py-px text-[11px] leading-4 font-semibold text-primary-foreground"
                        >
                          {(badges[item.path] ?? 0) > 99 ? '99+' : badges[item.path]}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
            </ul>
            <ChannelSidebar />
            <DirectMessagesSidebar />
            <VoiceDock />
          </nav>
          <DisplayPicker />

          <main className="panel flex min-w-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
              <Outlet />
            </div>
            {canSeeMembers && memberPanelOpen && !asideTaken && <MemberPanel />}
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </ShellContext.Provider>
  )
}
