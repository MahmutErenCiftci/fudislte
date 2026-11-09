import { KeyRoundIcon, ServerIcon, UsersIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { LanguageMenu } from '../../components/LanguageMenu'
import { type MessageKey, useT } from '../../i18n'
import { useChangeLanguage } from '../../lib/session'

export function BrandMark({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M11.5 22V10h9.5M11.5 16h7.5" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Split-screen layout for sign-in, setup and invitations: the form on the left, a
 * brand panel on wide screens on the right.
 */
export function AuthLayout({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const t = useT()
  const changeLanguage = useChangeLanguage()
  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="relative flex flex-col items-center justify-center px-6 py-16">
        <div className="absolute top-4 right-4">
          <LanguageMenu onChange={(l) => void changeLanguage(l)} />
        </div>
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center justify-center gap-2.5">
            <BrandMark className="size-10" />
            <span className="text-2xl font-bold tracking-tight">FUDISLTE</span>
          </div>
          <div className="mb-8 grid gap-2 text-center">
            <h1 className="text-[26px] leading-tight font-bold tracking-tight text-balance">{title}</h1>
            {description && <p className="text-[15px] text-pretty text-muted-foreground">{description}</p>}
          </div>
          <div className="panel p-8">{children}</div>
          <p className="mt-8 text-center text-xs text-muted-foreground">{t('auth.tagline')}</p>
        </div>
      </div>
      <BrandPanel />
    </div>
  )
}

const highlights: { icon: typeof KeyRoundIcon; title: MessageKey; text: MessageKey }[] = [
  { icon: KeyRoundIcon, title: 'auth.passwordless', text: 'auth.passwordlessText' },
  { icon: ServerIcon, title: 'auth.selfHosted', text: 'auth.selfHostedText' },
  { icon: UsersIcon, title: 'auth.oneWorkspace', text: 'auth.oneWorkspaceText' },
]

function BrandPanel() {
  const t = useT()
  return (
    <div className="relative hidden flex-col justify-center overflow-hidden border-l bg-linear-to-br from-primary-soft/80 via-background to-background px-14 py-12 lg:flex">
      <div aria-hidden="true" className="absolute -top-32 -right-32 size-96 rounded-full bg-primary/10 blur-3xl" />
      <ProductSketch />
      <h2 className="relative mt-12 max-w-lg text-[28px] leading-tight font-bold tracking-tight">{t('auth.brandTitle')}</h2>
      <p className="relative mt-3 max-w-lg text-[15px] text-muted-foreground">{t('auth.brandText')}</p>
      <div className="relative mt-10 grid max-w-xl grid-cols-3 gap-6">
        {highlights.map(({ icon: Icon, title, text }) => (
          <div key={title}>
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-foreground">
              <Icon className="size-5" />
            </span>
            <p className="mt-3 text-[14px] font-semibold">{t(title)}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{t(text)}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/** An abstract, content-free sketch of the app window. */
function ProductSketch() {
  const bar = 'rounded-full bg-muted'
  return (
    <div aria-hidden="true" className="panel relative w-full max-w-xl overflow-hidden">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <BrandMark className="size-5" />
        <span className="h-2.5 w-14 rounded-full bg-foreground/80" />
        <span className="mx-auto h-6 w-48 rounded-md border bg-background" />
        <span className="size-6 rounded-full bg-blue-200 dark:bg-blue-500/40" />
      </div>
      <div className="flex">
        <div className="grid w-32 content-start gap-2.5 border-r p-3">
          <span className="h-7 rounded-md bg-primary-soft" />
          {[70, 85, 60, 75, 55].map((w) => (
            <span key={w} className={`h-2 ${bar}`} style={{ width: `${w}%` }} />
          ))}
        </div>
        <div className="grid flex-1 content-start gap-4 p-4">
          {(
            [
              ['bg-violet-200 dark:bg-violet-500/40', 80, 55],
              ['bg-emerald-200 dark:bg-emerald-500/40', 90, 70],
              ['bg-amber-200 dark:bg-amber-500/40', 65, 40],
            ] as const
          ).map(([tone, a, b]) => (
            <div key={tone} className="flex gap-3">
              <span className={`size-7 shrink-0 rounded-full ${tone}`} />
              <div className="grid flex-1 gap-1.5 pt-1">
                <span className={`h-2 ${bar}`} style={{ width: `${a}%` }} />
                <span className={`h-2 ${bar}`} style={{ width: `${b}%` }} />
              </div>
            </div>
          ))}
          <span className="h-8 rounded-lg border bg-background" />
        </div>
        <div className="grid w-28 content-start gap-2.5 border-l p-3">
          {[
            'bg-blue-200 dark:bg-blue-500/40',
            'bg-rose-200 dark:bg-rose-500/40',
            'bg-cyan-200 dark:bg-cyan-500/40',
            'bg-orange-200 dark:bg-orange-500/40',
          ].map((tone) => (
            <div key={tone} className="flex items-center gap-2">
              <span className={`size-5 shrink-0 rounded-full ${tone}`} />
              <span className={`h-2 flex-1 ${bar}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function FullScreenMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full items-center justify-center p-8 text-center text-muted-foreground">{children}</div>
}
