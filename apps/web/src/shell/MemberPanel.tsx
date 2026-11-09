import type { Member, PresenceEntry } from '@fudislte/api-client'
import { Avatar, cn, Input, Popover, PopoverContent, PopoverTrigger, Spinner } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { CrownIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'

import { presenceDot, presenceLine, usePresenceMap } from '../features/presence/presence'
import { api, errorMessage, queryKeys } from '../lib/api'
import { groupMembersByRole } from '../lib/members'
import { isOwner } from '../lib/permissions'
import { useT } from '../i18n'
import { useWorkspace } from './context'
import { MemberCard } from './MemberCard'
import { searchKey } from '../lib/search'

/** Right-hand people list grouped by role, Discord style, with a quick filter. */
export function MemberPanel() {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const members = useQuery({ queryKey: queryKeys.members(orgId), queryFn: () => api.members(orgId) })
  const presence = usePresenceMap()
  const [query, setQuery] = useState('')

  const q = searchKey(query.trim())
  const visible = (members.data ?? []).filter(
    (m) => !q || searchKey(m.user.displayName).includes(q) || searchKey(m.user.email).includes(q),
  )

  return (
    <aside aria-label={t('people.title')} className="flex w-72 shrink-0 flex-col border-l">
      <div className="grid gap-3 px-4 pt-4 pb-2">
        <h2 className="text-[15px] font-semibold">
          {t('people.title')} <span className="font-normal text-muted-foreground">({members.data?.length ?? '…'})</span>
        </h2>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t('people.search')}
            placeholder={t('people.search')}
            className="h-8 bg-muted/60 pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {members.isPending && (
          <div className="flex justify-center p-6">
            <Spinner label={t('people.loading')} />
          </div>
        )}
        {members.error && <p className="p-3 text-[13px] text-destructive">{errorMessage(members.error)}</p>}
        {members.data && visible.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{t('people.empty')}</p>}
        {groupMembersByRole(visible).map((group) => (
          <section key={group.role.id} aria-labelledby={`role-${group.role.id}`}>
            <h3 id={`role-${group.role.id}`} className="px-2 pt-4 pb-1.5 text-[13px] font-semibold text-muted-foreground">
              {group.role.name} — {group.members.length}
            </h3>
            <ul className="grid gap-px">
              {group.members.map((m) => (
                <li key={m.user.id}>
                  <PersonRow member={m} presence={presence.get(m.user.id)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  )
}

function PersonRow({ member, presence }: { member: Member; presence: PresenceEntry | undefined }) {
  const t = useT()
  const { me } = useWorkspace()
  const [open, setOpen] = useState(false)
  const isSelf = member.user.id === me.user.id
  const offline = !presence || presence.state === 'offline'
  const line = presenceLine(presence, t)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent data-[state=open]:bg-accent',
            offline && 'opacity-60 hover:opacity-100',
          )}
        >
          <Avatar
            name={member.user.displayName}
            seed={member.user.id}
            size="md"
            dot={presenceDot(presence?.state, presence?.status, t)}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 truncate text-[14px] font-medium">
              <span className="truncate">{member.user.displayName}</span>
              {isOwner(member.role) && <CrownIcon aria-label={t('people.owner')} className="size-3.5 shrink-0 fill-amber-400 text-amber-500" />}
            </span>
            {(line || isSelf) && (
              <span className="block truncate text-xs text-muted-foreground">
                {isSelf ? (line ? t('people.you', { line }) : t('people.youOnly')) : line}
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" align="start" className="w-72">
        <MemberCard member={member} onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
