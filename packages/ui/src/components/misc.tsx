import { cva, type VariantProps } from 'class-variance-authority'
import { AlertCircleIcon, InfoIcon, Loader2Icon } from 'lucide-react'
import { Separator as SeparatorPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '../lib/cn'
import { useUiStrings } from './strings'

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-muted-foreground',
        primary: 'border-transparent bg-primary-soft text-primary-soft-foreground',
        destructive: 'border-transparent bg-destructive/10 text-destructive',
        success: 'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        amber: 'border-transparent bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
        violet: 'border-transparent bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
        emerald: 'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        pink: 'border-transparent bg-pink-50 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
        sky: 'border-transparent bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
        slate: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

export function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export function Separator({ className, orientation = 'horizontal', ...props }: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
      {...props}
    />
  )
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  const strings = useUiStrings()
  return <Loader2Icon role="status" aria-label={label ?? strings.loading} className={cn('size-4 animate-spin text-muted-foreground', className)} />
}

export function Alert({
  variant = 'info',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { variant?: 'info' | 'error' }) {
  const Icon = variant === 'error' ? AlertCircleIcon : InfoIcon
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]',
        variant === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'bg-muted/50 text-foreground',
        className,
      )}
      {...props}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn('rounded border bg-muted px-1 font-mono text-[11px] text-muted-foreground', className)}
      {...props}
    />
  )
}
