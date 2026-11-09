import type { Channel, Message } from '@fudislte/api-client'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRightIcon, PinIcon } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../i18n'
import { api, queryKeys } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { messagePreview } from './text'

/** "Sabitlenen mesaj" bar under the channel header, as in the mockup. */
export function PinnedBar({ orgId, channel, onJump }: { orgId: string; channel: Channel; onJump: (m: Message) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const pins = useQuery({ queryKey: queryKeys.pins(orgId, channel.id), queryFn: () => api.pins(orgId, channel.id) })
  const all = pins.data ?? []
  const latest = all[0]
  if (!latest) return null
  const describe = (m: Message) => `${m.author?.displayName ?? t('chat.deletedUser')}: ${messagePreview(m)}`

  return (
    <div className="mx-6 mt-3 flex shrink-0 items-center gap-3 rounded-xl border bg-primary-soft/40 px-4 py-2">
      <PinIcon className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">
          {t('chat.pinnedMessage')}
          {all.length > 1 && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <button className="ml-2 rounded text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
                  {t('chat.allPins', { count: all.length })}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-96 p-1">
                <ul className="max-h-80 overflow-y-auto">
                  {all.map((m) => (
                    <li key={m.id}>
                      <button
                        onClick={() => {
                          setOpen(false)
                          onJump(m)
                        }}
                        className="grid w-full gap-0.5 rounded-md px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
                      >
                        <span className="line-clamp-2 text-[13px]">{describe(m)}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {m.pinned?.by
                            ? t('chat.pinnedByAt', { name: m.pinned.by.displayName, date: formatDateTime(m.pinned.at) })
                            : formatDateTime(m.createdAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">{describe(latest)}</p>
      </div>
      <Button variant="ghost" size="sm" className="shrink-0 text-primary hover:text-primary" onClick={() => onJump(latest)}>
        {t('chat.goToMessage')}
        <ArrowRightIcon />
      </Button>
    </div>
  )
}
