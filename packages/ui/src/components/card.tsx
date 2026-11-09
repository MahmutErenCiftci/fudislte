import type * as React from 'react'

import { cn } from '../lib/cn'

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('rounded-xl border bg-card text-card-foreground', className)} {...props} />
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('grid gap-1 px-5 pt-5', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return <h3 className={cn('text-[15px] leading-tight font-semibold', className)} {...props} />
}

export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-[13px] text-muted-foreground', className)} {...props} />
}

export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 py-5', className)} {...props} />
}

export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-2 border-t px-5 py-3', className)} {...props} />
}
