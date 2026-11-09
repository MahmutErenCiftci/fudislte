import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/** Page title block at the top of the content panel. */
export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  children,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  actions?: ReactNode
  /** Rendered below the title, e.g. a tab bar. */
  children?: ReactNode
}) {
  return (
    <header className="shrink-0 px-6 pt-6">
      <div className="flex items-start gap-4">
        {Icon && (
          <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border bg-card text-muted-foreground">
            <Icon className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-[14px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}
