import { cn } from '@fudislte/ui'
import { type LucideIcon, SettingsIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'

import { useT } from '../../i18n'
import { useWorkspace } from '../../shell/context'
import { PageHeader } from '../../shell/PageHeader'
import { visibleSettingsSections } from './sections'

export function SettingsLayout() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const base = `/w/${workspace.organization.slug}/settings`
  return (
    <>
      <PageHeader icon={SettingsIcon} title={t('settings.title')} description={t('settings.description')}>
        <nav aria-label={t('settings.title')} className="mt-6 flex gap-1 overflow-x-auto border-b">
          {visibleSettingsSections(workspace, me.user).map((s) => (
            <NavLink
              key={s.path}
              to={`${base}/${s.path}`}
              className={({ isActive }) =>
                cn(
                  '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[14px] font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground',
                  isActive ? 'border-primary text-primary hover:text-primary' : 'border-transparent',
                )
              }
            >
              <s.icon className="size-4" />
              {t(s.label)}
            </NavLink>
          ))}
        </nav>
      </PageHeader>
      <div className="px-6 py-6">
        <Outlet />
      </div>
    </>
  )
}

/** A bordered settings card with an optional icon, description and actions. */
export function SettingsCard({
  icon: Icon,
  title,
  description,
  actions,
  children,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border bg-card', className)}>
      <header className="flex items-start gap-4 p-5">
        {Icon && (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-foreground">
            <Icon className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="px-5 pb-5">{children}</div>
    </section>
  )
}

/** Shown when a settings URL is opened by a member whose role lacks access. */
export function RequirePermission({ allowed, children }: { allowed: boolean; children: ReactNode }) {
  const t = useT()
  if (allowed) return children
  return <div className="rounded-xl border p-6 text-center text-[13px] text-muted-foreground">{t('settings.noAccess')}</div>
}
