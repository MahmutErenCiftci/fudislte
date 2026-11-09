import type { Channel } from '@fudislte/api-client'
import { Alert, Input, Spinner } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { DownloadIcon, FolderOpenIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { formatDate, formatSize } from '../../lib/format'
import { fileIcon } from './Attachments'
import { searchKey } from '../../lib/search'

/** The "Dosyalar" tab of a channel: every file sent in it, newest first. */
export function ChannelFiles({ orgId, channel }: { orgId: string; channel: Channel }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const files = useQuery({ queryKey: queryKeys.files(orgId, channel.id), queryFn: () => api.channelFiles(orgId, channel.id) })
  const q = searchKey(query.trim())
  const visible = (files.data ?? []).filter((f) => !q || searchKey(f.name).includes(q))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-4 max-w-sm">
        <Input
          icon={<SearchIcon />}
          aria-label={t('files.search')}
          placeholder={t('files.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {files.isPending && (
        <div className="flex justify-center p-8">
          <Spinner />
        </div>
      )}
      {files.error && <Alert variant="error">{errorMessage(files.error)}</Alert>}
      {files.data?.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
          <FolderOpenIcon className="size-8 text-muted-foreground" />
          <p className="text-[14px] font-medium">{t('files.empty')}</p>
          <p className="max-w-sm text-[13px] text-muted-foreground">{t('files.emptyHint')}</p>
        </div>
      )}
      {visible.length > 0 && (
        <ul className="divide-y rounded-xl border bg-card">
          {visible.map((f) => {
            const Icon = fileIcon(f.contentType)
            return (
              <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                {f.image ? (
                  <img
                    src={api.fileUrl(orgId, f.id)}
                    alt=""
                    loading="lazy"
                    className="size-10 shrink-0 rounded-lg border object-cover"
                  />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                    <Icon className="size-5" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <a
                    href={api.fileUrl(orgId, f.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-[14px] font-medium hover:underline"
                  >
                    {f.name}
                  </a>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatSize(f.size)} · {f.uploader?.displayName ?? t('chat.deletedUser')} · {formatDate(f.createdAt)}
                  </span>
                </span>
                <a
                  href={api.fileUrl(orgId, f.id, true)}
                  download={f.name}
                  aria-label={`${t('files.download')}: ${f.name}`}
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <DownloadIcon className="size-4" />
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
