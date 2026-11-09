import { Label as LabelPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '../lib/cn'

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn('text-[13px] leading-none font-medium select-none peer-disabled:opacity-50', className)}
      {...props}
    />
  )
}

interface FieldProps {
  label: string
  /** Validation message; marks the control invalid and is announced to screen readers. */
  error?: string | undefined
  hint?: string
  className?: string
  children: React.ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>
}

/** Label + control + hint/error, wired together for accessibility. */
export function Field({ label, error, hint, className, children }: FieldProps) {
  const id = React.useId()
  const messageId = `${id}-message`
  const control = React.cloneElement(children, {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error || hint ? messageId : undefined,
  })
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {(error || hint) && (
        <p id={messageId} className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
          {error ?? hint}
        </p>
      )}
    </div>
  )
}
