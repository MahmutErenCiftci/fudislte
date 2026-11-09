import type * as React from 'react'

import { cn } from '../lib/cn'
import { useUiStrings } from './strings'

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts
  return letters.map((p) => Array.from(p)[0]!.toLocaleUpperCase('tr')).join('') || '?'
}

const sizes = {
  xs: 'size-5 text-[9px]',
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-[13px]',
  lg: 'size-12 text-base',
  xl: 'size-16 text-xl',
}

const dotSizes = { xs: 'size-1.5', sm: 'size-2.5', md: 'size-3', lg: 'size-3.5', xl: 'size-4' }

/** Soft background + strong text pairs; each person gets a stable one from their ID. */
const tones = [
  'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200',
  'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200',
  'bg-cyan-100 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-200',
  'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200',
]

function toneFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return tones[h % tones.length]!
}

interface AvatarProps extends React.ComponentProps<'span'> {
  name: string
  /** Stable value (usually the user ID) that picks the color. Defaults to the name. */
  seed?: string
  size?: keyof typeof sizes
  /** Shows a green dot; only pass it when the person is known to be online. */
  online?: boolean
  /** A presence dot in any color (a background class) with its spoken label. */
  dot?: { className: string; label: string }
}

/** Initials avatar. */
export function Avatar({ name, seed, size = 'sm', online, dot, className, ...props }: AvatarProps) {
  const strings = useUiStrings()
  const shown = dot ?? (online ? { className: 'bg-success', label: strings.online } : undefined)
  return (
    <span className={cn('relative inline-flex shrink-0', className)} {...props}>
      <span
        role="img"
        aria-label={name}
        className={cn(
          'inline-flex size-full items-center justify-center rounded-full font-semibold select-none',
          sizes[size],
          toneFor(seed ?? name),
        )}
      >
        {initials(name)}
      </span>
      {shown && (
        <span
          role="img"
          aria-label={shown.label}
          className={cn('absolute right-0 bottom-0 rounded-full ring-2 ring-card', shown.className, dotSizes[size])}
        />
      )}
    </span>
  )
}
