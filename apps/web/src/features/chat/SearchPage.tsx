import type { SearchResult } from '@fudislte/api-client'
import { Alert, Avatar, Input, NativeSelect, Spinner } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { SearchIcon, SearchXIcon } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useWorkspace } from '../../shell/context'
import { PageHeader } from '../../shell/PageHeader'
import { useChannels } from './ChannelSidebar'
import { useConversations } from './DirectMessages'
import { channelLabel, channelTitle } from './names'
import { messagePreview } from './text'

/** The words of a query, for highlighting. */
export function searchWords(query: string): string[] {
  return query.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Wraps the parts of text that start with a searched word in <mark>. */
export function Highlighted({ text, words }: { text: string; words: string[] }) {
  if (words.length === 0) return <>{text}</>
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const parts = text.split(new RegExp(`((?:${escaped.join('|')})[\\p{L}\\p{N}]*)`, 'giu'))
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-500/30">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

/** Where a search result opens: its thread, or the message in its channel. */
export function resultLink(slug: string, r: SearchResult): string {
  const m = r.message
  return m.parentId ? `/w/${slug}/c/${m.channelId}?thread=${m.parentId}` : `/w/${slug}/c/${m.channelId}?message=${m.id}`
}

/** Debounced copy of a value, so typing does not send a request per key. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

/** /w/:slug/search?q= — message search across the caller's channels and conversations. */
export function SearchPage() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const [params, setParams] = useSearchParams()
  const [input, setInput] = useState(params.get('q') ?? '')
  const channelId = params.get('in') ?? ''
  const query = useDebounced(input.trim())
  const channels = useChannels()
  const conversations = useConversations()
  const words = searchWords(query)

  useEffect(() => {
    setParams(
      (p) => {
        if (query) p.set('q', query)
        else p.delete('q')
        return p
      },
      { replace: true },
    )
  }, [query, setParams])

  const results = useQuery({
    queryKey: queryKeys.search(orgId, query, channelId),
    queryFn: () => api.search(orgId, { q: query, channelId: channelId || undefined, limit: 50 }),
    enabled: words.length > 0,
  })

  return (
    <>
      <PageHeader icon={SearchIcon} title={t('search.title')} description={t('search.description')} />
      <div className="grid gap-4 px-6 py-6">
        <div className="flex flex-wrap gap-3">
          <Input
            autoFocus
            icon={<SearchIcon />}
            aria-label={t('search.placeholder')}
            placeholder={t('search.placeholder')}
            className="w-full max-w-lg"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <NativeSelect
            aria-label={t('search.in')}
            className="w-56"
            value={channelId}
            onChange={(e) =>
              setParams((p) => {
                if (e.target.value) p.set('in', e.target.value)
                else p.delete('in')
                return p
              })
            }
          >
            <option value="">{t('search.everywhere')}</option>
            {channels.data?.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
            {conversations.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {channelTitle(c, me.user.id, t)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {words.length === 0 && <p className="text-[13px] text-muted-foreground">{t('search.hint')}</p>}
        {results.isFetching && !results.data && (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        )}
        {results.error && <Alert variant="error">{errorMessage(results.error)}</Alert>}
        {results.data?.length === 0 && words.length > 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
            <SearchXIcon className="size-8 text-muted-foreground" />
            <p className="text-[14px] font-medium">{t('search.empty', { query })}</p>
          </div>
        )}
        {results.data && results.data.length > 0 && words.length > 0 && (
          <ul className="divide-y rounded-xl border bg-card">
            {results.data.map((r) => {
              const author = r.message.author?.displayName ?? t('chat.deletedUser')
              return (
                <li key={r.message.id}>
                  <Link
                    to={resultLink(workspace.organization.slug, r)}
                    className="flex gap-3 px-4 py-3 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
                  >
                    <Avatar name={author} seed={r.message.author?.id ?? r.message.id} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                        <span className="font-semibold">{author}</span>
                        <span className="text-muted-foreground">
                          {r.channel ? channelLabel(r.channel, me.user.id, t) : ''}
                          {r.message.parentId && ` · ${t('search.inThread')}`}
                        </span>
                        <span className="text-xs text-muted-foreground">{formatDateTime(r.message.createdAt)}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-3 block text-[14px]">
                        <Highlighted text={messagePreview(r.message)} words={words} />
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}
