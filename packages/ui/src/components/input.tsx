import type * as React from 'react'

import { cn } from '../lib/cn'

const fieldBase =
  'w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/20'

type InputProps = React.ComponentProps<'input'> & {
  /** Decorative icon shown inside the field on the left. */
  icon?: React.ReactNode
}

export function Input({ className, type, icon, ...props }: InputProps) {
  const input = <input type={type} data-slot="input" className={cn(fieldBase, 'h-9 py-1', icon && 'pl-9', className)} {...props} />
  if (!icon) return input
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground [&>svg]:size-4">
        {icon}
      </span>
      {input}
    </div>
  )
}

/** A styled native select: accessible, keyboard friendly and dependency free. */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(fieldBase, 'h-9 py-1 pr-8', className)} {...props} />
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(fieldBase, 'min-h-16 py-2', className)} {...props} />
}
