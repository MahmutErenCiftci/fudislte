import { Alert, Button, cn, Input, Spinner } from '@fudislte/ui'
import { MessageSquareIcon, SquarePenIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { errorMessage } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { PageHeader } from '../../shell/PageHeader'
import { ConversationAvatar, NewMessageDialog, useConversations } from './DirectMessages'
import { channelTitle } from './names'
import { messagePreview } from './text'
import { searchKey } from '../../lib/search'

/** /w/:slug/messages — every direct conversation with its latest message. */
export function MessagesPage() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const conversations = useConversations()
  const [query, setQuery] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const canStart = can(workspace, 'members.view')
  const root = `/w/${workspace.organization.slug}`

  const q = searchKey(query.trim())
  const visible = (conversations.data ?? []).filter((c) => !q || searchKey(channelTitle(c, me.user.id, t)).includes(q))

  return (
    <>
      <PageHeader
        icon={MessageSquareIcon}
        title={t('nav.messages')}
        description={t('dm.inboxDescription')}
        actions={
          canStart && (
            <Button onClick={() => setNewOpen(true)}>
              <SquarePenIcon />
              {t('dm.new')}
            </Button>
          )
        }
      />
      <div className="grid gap-4 px-6 py-6">
        <Input
          icon={<SearchIcon />}
          aria-label={t('dm.search')}
          placeholder={t('dm.search')}
          className="max-w-md"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {conversations.isPending && (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        )}
        {conversations.error && <Alert variant="error">{errorMessage(conversations.error)}</Alert>}
        {conversations.data?.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
            <MessageSquareIcon className="size-8 text-muted-foreground" />
            <p className="text-[15px] font-medium">{t('dm.empty')}</p>
            <p className="max-w-sm text-[13px] text-muted-foreground">{t('dm.emptyHint')}</p>
            {canStart && <Button onClick={() => setNewOpen(true)}>{t('dm.new')}</Button>}
          </div>
        )}
        {conversations.data && conversations.data.length > 0 && visible.length === 0 && (
          <p className="text-[13px] text-muted-foreground">{t('dm.noMatch')}</p>
        )}
        {visible.length > 0 && (
          <ul className="divide-y rounded-xl border bg-card">
            {visible.map((c) => {
              const last = c.lastMessage
              const unread = c.unreadCount > 0
              const author = last?.author?.id === me.user.id ? t('dm.you') : last?.author?.displayName
              return (
                <li key={c.id}>
                  <Link
                    to={`${root}/c/${c.id}`}
                    className="flex items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
                  >
                    <ConversationAvatar conversation={c} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={cn('truncate text-[14px]', unread ? 'font-semibold' : 'font-medium')}>
                          {channelTitle(c, me.user.id, t)}
                        </span>
                        {last && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatRelative(last.createdAt)}</span>}
                      </span>
                      <span className={cn('block truncate text-[13px]', unread ? 'text-foreground' : 'text-muted-foreground')}>
                        {last ? `${author ?? ''}: ${messagePreview(last)}` : t('dm.noMessages')}
                      </span>
                    </span>
                    {unread && (
                      <span
                        aria-label={t('chat.unread', { count: c.unreadCount })}
                        className="rounded-full bg-primary px-1.5 py-px text-[11px] leading-4 font-semibold text-primary-foreground"
                      >
                        {c.unreadCount > 99 ? '99+' : c.unreadCount}
                      </span>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {canStart && <NewMessageDialog open={newOpen} onOpenChange={setNewOpen} />}
    </>
  )
}
