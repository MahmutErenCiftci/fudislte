import { CheckIcon } from 'lucide-react'
import { DropdownMenu as MenuPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '../lib/cn'

export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-44 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

const itemBase =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"

export function DropdownMenuItem({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & { variant?: 'destructive' }) {
  return (
    <MenuPrimitive.Item
      className={cn(itemBase, variant === 'destructive' && 'text-destructive data-[highlighted]:text-destructive', className)}
      {...props}
    />
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemBase, 'pl-7', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}
