import type { Member } from '@fudislte/api-client'
import { Avatar, Badge, Button } from '@fudislte/ui'
import { MailIcon, MessageSquareIcon } from 'lucide-react'
import { Link } from 'react-router'

import { useOpenConversation } from '../features/chat/DirectMessages'
import { presenceDot, presenceLine, usePresenceMap } from '../features/presence/presence'
import { useT } from '../i18n'
import { errorMessage } from '../lib/api'
import { formatDate } from '../lib/format'
import { roleStyle } from '../lib/roles'
import { useWorkspace } from './context'

/** Compact profile shown from the people panel and the command palette. */
export function MemberCard({ member, onNavigate }: { member: Member; onNavigate?: () => void }) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const isSelf = member.user.id === me.user.id
  const { tone, icon: RoleIcon } = roleStyle(member.role.key)
  const message = useOpenConversation(onNavigate)
  const presence = usePresenceMap().get(member.user.id)
  const line = presenceLine(presence, t)
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <Avatar name={member.user.displayName} seed={member.user.id} size="lg" dot={presenceDot(presence?.state, presence?.status, t)} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold">{member.user.displayName}</p>
          <Badge variant={tone} className="mt-1">
            <RoleIcon />
            {member.role.name}
          </Badge>
          {line && <p className="mt-1 truncate text-xs text-muted-foreground">{line}</p>}
        </div>
      </div>
      <div className="grid gap-2 text-[13px]">
        <div className="flex items-center gap-2 text-muted-foreground">
          <MailIcon className="size-4 shrink-0" />
          <a href={`mailto:${member.user.email}`} className="truncate text-foreground hover:underline">
            {member.user.email}
          </a>
        </div>
        <p className="text-muted-foreground">{t('people.joined', { date: formatDate(member.joinedAt) })}</p>
      </div>
      {message.error && <p className="text-xs text-destructive">{errorMessage(message.error)}</p>}
      <div className="grid gap-2">
        <Button size="sm" disabled={message.isPending} onClick={() => message.mutate(isSelf ? [] : [member.user.id])}>
          <MessageSquareIcon />
          {isSelf ? t('dm.noteToSelf') : t('dm.sendMessage')}
        </Button>
        {isSelf && (
          <Button variant="outline" size="sm" asChild>
            <Link to={`/w/${workspace.organization.slug}/settings/account`} onClick={onNavigate}>
              {t('people.editProfile')}
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}
