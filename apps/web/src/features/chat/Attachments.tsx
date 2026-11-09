import type { Attachment } from '@fudislte/api-client'
import { cn, Spinner } from '@fudislte/ui'
import {
  AlertCircleIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  type LucideIcon,
  XIcon,
} from 'lucide-react'

import { useT } from '../../i18n'
import { api } from '../../lib/api'
import { formatSize } from '../../lib/format'

export function fileIcon(contentType: string): LucideIcon {
  if (contentType.startsWith('image/')) return FileImageIcon
  if (contentType === 'application/zip' || contentType.includes('compressed') || contentType.includes('x-gzip')) return FileArchiveIcon
  if (contentType === 'text/html' || contentType.includes('javascript') || contentType.includes('json') || contentType.includes('xml'))
    return FileCodeIcon
  if (contentType.startsWith('text/') || contentType === 'application/pdf') return FileTextIcon
  return FileIcon
}

/** Files sent with a message: image previews, then cards for everything else. */
export function MessageAttachments({ orgId, attachments }: { orgId: string; attachments: Attachment[] }) {
  const t = useT()
  const images = attachments.filter((a) => a.image)
  const files = attachments.filter((a) => !a.image)
  return (
    <div className="mt-1.5 grid gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <a
              key={a.id}
              href={api.fileUrl(orgId, a.id)}
              target="_blank"
              rel="noopener noreferrer"
              title={a.name}
              className="block w-fit max-w-[min(100%,24rem)] overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <img src={api.fileUrl(orgId, a.id)} alt={a.name} loading="lazy" className="max-h-64 w-full object-contain" />
            </a>
          ))}
        </div>
      )}
      {files.map((a) => {
        const Icon = fileIcon(a.contentType)
        return (
          <a
            key={a.id}
            href={api.fileUrl(orgId, a.id, true)}
            download={a.name}
            className="flex max-w-md items-center gap-3 rounded-lg border bg-card px-3 py-2.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{a.name}</span>
              <span className="block text-xs text-muted-foreground">{formatSize(a.size)}</span>
            </span>
            <DownloadIcon aria-label={t('files.download')} className="size-4 shrink-0 text-muted-foreground" />
          </a>
        )
      })}
    </div>
  )
}

export interface PendingUpload {
  key: string
  name: string
  size: number
  attachment?: Attachment
  error?: string
}

/** Files waiting in the composer: uploading, ready or failed. */
export function PendingUploads({ uploads, onRemove }: { uploads: PendingUpload[]; onRemove: (key: string) => void }) {
  const t = useT()
  if (uploads.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2 px-1 pb-2">
      {uploads.map((u) => {
        const Icon = u.attachment ? fileIcon(u.attachment.contentType) : FileIcon
        return (
          <li
            key={u.key}
            className={cn(
              'flex max-w-64 items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1 pl-2 text-xs',
              u.error && 'border-destructive/40 bg-destructive/5',
            )}
          >
            {u.error ? (
              <AlertCircleIcon className="size-4 shrink-0 text-destructive" />
            ) : u.attachment ? (
              <Icon className="size-4 shrink-0 text-primary" />
            ) : (
              <Spinner className="size-4" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{u.name}</span>
              <span className={cn('block truncate', u.error ? 'text-destructive' : 'text-muted-foreground')}>
                {u.error ?? formatSize(u.size)}
              </span>
            </span>
            <button
              type="button"
              aria-label={t('files.remove', { name: u.name })}
              onClick={() => onRemove(u.key)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
