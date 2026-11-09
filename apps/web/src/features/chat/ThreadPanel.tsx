import type { Channel, Message, Person } from '@fudislte/api-client'
import { Alert, Button, Spinner } from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { XIcon } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { addMessage } from './cache'
import { Composer } from './Composer'
import { type MessageActions, MessageRow, Separator } from './MessageList'
import { channelLabel } from './names'
import { arrangeMessages } from './text'

/** A thread beside its channel: the root, every reply and a reply composer. */
export function ThreadPanel({
  channel,
  rootId,
  actions,
  people,
  onClose,
}: {
  channel: Channel
  rootId: string
  actions: MessageActions
  people: Person[]
  onClose: () => void
}) {
  const t = useT()
  const { me } = useWorkspace()
  const { orgId } = actions
  const qc = useQueryClient()
  const scroller = useRef<HTMLDivElement>(null)
  const thread = useQuery({
    queryKey: queryKeys.thread(orgId, channel.id, rootId),
    queryFn: () => api.replies(orgId, channel.id, rootId),
    staleTime: Infinity, // live events keep it current
  })
  const send = useMutation({
    mutationFn: ({ body, attachmentIds }: { body: string; attachmentIds: string[] }) =>
      api.sendMessage(orgId, channel.id, body, rootId, attachmentIds),
    onSuccess: (message: Message) => addMessage(qc, orgId, message),
  })
  const replies = thread.data?.replies
  const rows = useMemo(() => arrangeMessages(replies ?? []), [replies])
  const inThread: MessageActions = { ...actions, onOpenThread: undefined }

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [replies?.length])

  const title = channelLabel(channel, me.user.id, t)
  return (
    <aside aria-label={t('chat.thread')} className="flex w-[380px] shrink-0 flex-col border-l">
      <header className="flex h-[69px] shrink-0 items-center gap-2 border-b px-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">{t('chat.thread')}</h2>
          <p className="truncate text-xs text-muted-foreground">{title}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('chat.closeThread')} onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pt-2 pb-2">
        {thread.isPending && (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        )}
        {thread.error && (
          <div className="p-4">
            <Alert variant="error">{errorMessage(thread.error)}</Alert>
          </div>
        )}
        {thread.data && (
          <>
            <MessageRow message={{ ...thread.data.root, thread: undefined }} actions={inThread} />
            <Separator>{t('chat.replies', { count: thread.data.replies.length })}</Separator>
            {rows.map(({ message, continued }) => (
              <MessageRow key={message.id} message={message} actions={inThread} continued={continued} />
            ))}
          </>
        )}
      </div>
      {send.error && (
        <div className="px-4 pb-2">
          <Alert variant="error">{errorMessage(send.error)}</Alert>
        </div>
      )}
      {channel.joined && !channel.archivedAt && thread.data && (
        <Composer
          compact
          draftKey={`thread:${rootId}`}
          placeholder={t('chat.replyPlaceholder')}
          people={people}
          typingIn={{ channelId: channel.id, parentId: rootId }}
          onTyping={() => void api.typing(orgId, channel.id, rootId).catch(() => {})}
          onUpload={(file) => api.uploadFile(orgId, channel.id, file, file.name)}
          onDiscard={(id) => void api.deleteUpload(orgId, id).catch(() => {})}
          onSend={(body, attachmentIds) => send.mutateAsync({ body, attachmentIds })}
        />
      )}
    </aside>
  )
}
