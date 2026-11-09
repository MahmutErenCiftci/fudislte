import type { Message } from '@fudislte/api-client'
import { cn, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SmilePlusIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useT } from '../../i18n'
import { api } from '../../lib/api'
import { setReactions } from './cache'

/** Shown first in the message toolbar. */
export const quickEmojis = ['👍', '❤️', '😂', '🎉', '👀', '🙏']

// A small built-in set instead of an emoji library: no extra dependency or license.
const pickerEmojis = [
  '👍', '👎', '👏', '🙌', '🙏', '💪', '🤝', '👋', '👀', '🫡',
  '😀', '😄', '😂', '🤣', '😊', '😍', '🥳', '😎', '🤔', '🙃',
  '😅', '😢', '😮', '😴', '🤯', '😬', '🫠', '🤗', '😇', '🥲',
  '❤️', '🔥', '🎉', '✨', '⭐', '💯', '✅', '❌', '⚠️', '🚀',
  '💡', '📌', '📎', '🐛', '🛠️', '📈', '⏰', '☕', '🍕', '🎯',
]

/** Adds or removes the signed-in member's emoji on a message. */
export function useToggleReaction(orgId: string, message: Message, meId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (emoji: string) => {
      const mine = message.reactions?.find((r) => r.emoji === emoji)?.users.some((u) => u.id === meId)
      return mine
        ? api.removeReaction(orgId, message.channelId, message.id, emoji)
        : api.addReaction(orgId, message.channelId, message.id, emoji)
    },
    onSuccess: (reactions) => setReactions(qc, orgId, message.channelId, message.id, reactions),
  })
}

export function EmojiPicker({ onPick, children }: { onPick: (emoji: string) => void; children: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-[312px] p-2">
        <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">{t('chat.react')}</p>
        <div className="grid grid-cols-10 gap-0.5">
          {pickerEmojis.map((e) => (
            <button
              key={e}
              aria-label={e}
              onClick={() => {
                onPick(e)
                setOpen(false)
              }}
              className="flex size-7 items-center justify-center rounded-md text-lg outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {e}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Reaction chips under a message: count, who reacted, and a click to join or leave. */
export function ReactionBar({ orgId, message, meId, canReact }: { orgId: string; message: Message; meId: string; canReact: boolean }) {
  const t = useT()
  const toggle = useToggleReaction(orgId, message, meId)
  if (!message.reactions?.length) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {message.reactions.map((r) => {
        const mine = r.users.some((u) => u.id === meId)
        const names = r.users.map((u) => (u.id === meId ? t('dm.you') : u.displayName)).join(', ')
        return (
          <Tooltip key={r.emoji} content={t('chat.reactedWith', { names, emoji: r.emoji })} side="top">
            <button
              aria-pressed={mine}
              aria-label={t('chat.reactedWith', { names, emoji: r.emoji })}
              disabled={!canReact || toggle.isPending}
              onClick={() => toggle.mutate(r.emoji)}
              className={cn(
                'flex h-7 items-center gap-1 rounded-full border px-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default',
                mine ? 'border-primary/40 bg-primary-soft text-primary-soft-foreground' : 'bg-card hover:bg-accent',
              )}
            >
              <span className="text-[15px] leading-none">{r.emoji}</span>
              <span className="font-medium tabular-nums">{r.users.length}</span>
            </button>
          </Tooltip>
        )
      })}
      {canReact && (
        <EmojiPicker onPick={(e) => toggle.mutate(e)}>
          <button
            aria-label={t('chat.addReaction')}
            className="flex h-7 w-8 items-center justify-center rounded-full border bg-card text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <SmilePlusIcon className="size-4" />
          </button>
        </EmojiPicker>
      )}
    </div>
  )
}
