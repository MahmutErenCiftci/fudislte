import { getPlatform } from '@fudislte/platform'
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleDotIcon, LogOutIcon, MonitorIcon, MoonIcon, ServerIcon, SunIcon, UserIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { liveStatus, presenceDot, statusLabel, usePresenceMap } from '../features/presence/presence'
import { StatusDialog } from '../features/presence/StatusDialog'

import { useT } from '../i18n'
import { api, queryKeys } from '../lib/api'
import { setTheme, type Theme, useTheme } from '../lib/theme'
import { useWorkspace } from './context'

/** Avatar menu in the top bar: account, theme, desktop server and sign-out. */
export function UserMenu() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const theme = useTheme()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const platform = getPlatform()
  const [statusOpen, setStatusOpen] = useState(false)
  const presence = usePresenceMap()
  const status = liveStatus(me.user.status)
  const dot = presenceDot(presence.get(me.user.id)?.state ?? 'online', status, t)

  const signOut = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.clear()
      queryClient.setQueryData(queryKeys.me, null)
      navigate('/login', { replace: true })
    },
  })

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button aria-label={t('shell.accountMenu')} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          <Avatar name={me.user.displayName} seed={me.user.id} size="md" dot={dot} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar name={me.user.displayName} seed={me.user.id} size="md" dot={dot} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold">{me.user.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setStatusOpen(true)}>
          <CircleDotIcon />
          <span className="min-w-0 flex-1 truncate">{status ? statusLabel(status, t) : t('status.set')}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={`/w/${workspace.organization.slug}/settings/account`}>
            <UserIcon />
            {t('shell.myAccount')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('theme.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="light">
            <SunIcon />
            {t('theme.light')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon />
            {t('theme.dark')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon />
            {t('theme.system')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {platform.desktop && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void platform.desktop?.changeServer()}>
              <ServerIcon />
              {t('shell.changeServer')}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut.mutate()} disabled={signOut.isPending}>
          <LogOutIcon />
          {t('shell.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {statusOpen && <StatusDialog open onOpenChange={setStatusOpen} />}
    </>
  )
}
