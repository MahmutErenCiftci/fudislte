import { CheckIcon } from 'lucide-react'
import { Checkbox as CheckboxPrimitive, Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '../lib/cn'

export const TooltipProvider = TooltipPrimitive.Provider

/** Short text hint, mainly for icon-only buttons. */
export function Tooltip({
  content,
  side = 'right',
  children,
}: {
  content: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: React.ReactNode
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger

export function PopoverContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        className={cn('z-50 w-64 rounded-xl border bg-popover p-4 text-popover-foreground shadow-md outline-none', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <CheckIcon className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
