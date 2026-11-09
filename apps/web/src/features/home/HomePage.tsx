import { Avatar, Badge, Checkbox, cn } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRightIcon,
  Building2Icon,
  CalendarDaysIcon,
  CheckIcon,
  GlobeLockIcon,
  HistoryIcon,
  KeyRoundIcon,
  ListChecksIcon,
  type LucideIcon,
  MoonIcon,
  ShieldCheckIcon,
  SunIcon,
  SunriseIcon,
  UserPlusIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { type MessageKey, useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { auditPhrase, describeEvent } from '../../lib/audit'
import { formatDate, formatLongDate, formatRelative } from '../../lib/format'
import { can } from '../../lib/permissions'
import { roleStyle } from '../../lib/roles'
import { useWorkspace } from '../../shell/context'
import { MeetingRow, useMeetings, useNow } from '../meetings/meetings'
import { canJoin, meetingPhase } from '../meetings/time'
import { compareForList } from '../projects/filters'
import { DueDate, PriorityBadge, useMyTasks, useProjectLinks, useToggleDone } from '../projects/projects'

const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000

function greeting(hour: number): { key: MessageKey; icon: LucideIcon } {
  if (hour < 12) return { key: 'home.goodMorning', icon: SunriseIcon }
  if (hour < 18) return { key: 'home.goodAfternoon', icon: SunIcon }
  return { key: 'home.goodEvening', icon: MoonIcon }
}

export function HomePage() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const org = workspace.organization
  const settings = `/w/${org.slug}/settings`
  const canViewMembers = can(workspace, 'members.view')
  const canManageOrg = can(workspace, 'org.manage')
  const canAudit = can(workspace, 'audit.view')

  const members = useQuery({ queryKey: queryKeys.members(org.id), queryFn: () => api.members(org.id), enabled: canViewMembers })
  const domains = useQuery({ queryKey: queryKeys.domains(org.id), queryFn: () => api.domains(org.id), enabled: canManageOrg })
  const activity = useQuery({
    queryKey: [...queryKeys.audit(org.id), 'recent'],
    queryFn: () => api.auditEvents(org.id),
    enabled: canAudit,
  })
  const meetings = useMeetings('upcoming')
  const nowMs = useNow()
  const nextMeetings = (meetings.data ?? []).filter((m) => !m.canceledAt).slice(0, 3)

  const now = new Date()
  const { key: greetingKey, icon: GreetingIcon } = greeting(now.getHours())
  const firstName = me.user.displayName.split(' ')[0]
  // An account opened in the last day is greeted as new; "welcome back" after that.
  const isNewAccount = nowMs - Date.parse(me.user.createdAt) < NEW_ACCOUNT_MS
  const canInvite = can(workspace, 'members.invite')
  const accessKeys = useQuery({ queryKey: queryKeys.accessKeys(org.id), queryFn: () => api.accessKeys(org.id), enabled: canInvite })

  const steps: { key: string; title: MessageKey; text: MessageKey; icon: LucideIcon; to: string; done?: boolean }[] = []
  if (canInvite) {
    // The usual way into a company workspace: IT prepares the account, the person enters a key.
    steps.push({
      key: 'keys',
      title: 'home.stepKeys',
      text: 'home.stepKeysText',
      icon: KeyRoundIcon,
      to: `${settings}/security`,
      done: (accessKeys.data?.length ?? 0) > 0 || (members.data?.length ?? 0) > 1,
    })
    steps.push({
      key: 'invite',
      title: 'home.stepInvite',
      text: 'home.stepInviteText',
      icon: UserPlusIcon,
      to: `${settings}/users`,
      done: (members.data?.length ?? 0) > 1,
    })
  }
  if (canManageOrg) {
    steps.push({
      key: 'domain',
      title: 'home.stepDomain',
      text: 'home.stepDomainText',
      icon: GlobeLockIcon,
      to: `${settings}/access`,
      done: (domains.data?.length ?? 0) > 0,
    })
  }
  if (can(workspace, 'roles.manage')) {
    steps.push({ key: 'roles', title: 'home.stepRoles', text: 'home.stepRolesText', icon: ShieldCheckIcon, to: `${settings}/roles` })
  }

  const newest = [...(members.data ?? [])].sort((a, b) => b.joinedAt.localeCompare(a.joinedAt)).slice(0, 5)
  const RoleIcon = roleStyle(workspace.role.key).icon

  return (
    <div className="grid content-start gap-6 p-6">
      <section className="relative overflow-hidden rounded-2xl border bg-linear-to-br from-primary-soft via-card to-card px-8 py-8">
        <div aria-hidden="true" className="absolute top-6 right-10 hidden h-40 w-72 md:block">
          <div className="absolute top-4 right-24 size-28 rotate-12 rounded-3xl bg-primary/10" />
          <div className="absolute top-10 right-4 size-32 rounded-full bg-primary/15" />
          <div className="absolute top-0 right-40 size-16 -rotate-6 rounded-2xl bg-primary/5" />
        </div>
        <p className="relative flex items-center gap-2 text-[15px] text-muted-foreground">
          <GreetingIcon className="size-5 text-amber-500" />
          {t(greetingKey)}
        </p>
        <h1 className="relative mt-1 text-3xl font-bold tracking-tight">{t(isNewAccount ? 'home.welcome' : 'home.welcomeBack', { name: firstName ?? '' })}</h1>
        <p className="relative mt-2 max-w-2xl text-[15px] text-muted-foreground">
          {t('home.today', { date: formatLongDate(now), workspace: org.name, role: workspace.role.name })}
        </p>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid content-start gap-6">
          <MyTasksCard />
          {steps.length > 0 && (
            <HomeCard icon={ListChecksIcon} title={t('home.getStarted')}>
              <ul className="divide-y">
                {steps.map((s) => (
                  <li key={s.key}>
                    <Link to={s.to} className="flex items-center gap-4 px-5 py-3.5 outline-none hover:bg-accent/60 focus-visible:bg-accent/60">
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-lg',
                          s.done ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-primary-soft text-primary-soft-foreground',
                        )}
                      >
                        {s.done ? <CheckIcon className="size-4" /> : <s.icon className="size-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-[14px] font-medium', s.done && 'text-muted-foreground line-through')}>{t(s.title)}</span>
                        <span className="block text-[13px] text-muted-foreground">{t(s.text)}</span>
                      </span>
                      {s.done ? <Badge variant="success">{t('home.done')}</Badge> : <ArrowRightIcon className="size-4 text-muted-foreground" />}
                    </Link>
                  </li>
                ))}
              </ul>
            </HomeCard>
          )}

          {canAudit && (
            <HomeCard icon={HistoryIcon} title={t('home.activity')} action={<ViewAll to={`${settings}/audit`} />}>
              {activity.data?.events.length === 0 && <p className="px-5 py-6 text-[13px] text-muted-foreground">{t('home.activityEmpty')}</p>}
              <ul className="divide-y">
                {activity.data?.events.slice(0, 6).map((e) => (
                  <li key={e.id} className="flex items-start gap-3 px-5 py-3">
                    <Avatar name={e.actor?.displayName ?? '?'} seed={e.actor?.id} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px]">
                        <span className="font-semibold">{e.actor?.displayName ?? t('audit.deletedUser')}</span>, {auditPhrase(e.action)}
                      </p>
                      {describeEvent(e) && <p className="truncate text-[13px] text-muted-foreground">{describeEvent(e)}</p>}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(e.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </HomeCard>
          )}
        </div>

        <div className="grid content-start gap-6">
          {nextMeetings.length > 0 && (
            <HomeCard icon={CalendarDaysIcon} title={t('meetings.upcomingTitle')} action={<ViewAll to={`/w/${org.slug}/meetings`} />}>
              <ul className="divide-y">
                {nextMeetings.map((m) => (
                  <MeetingRow key={m.id} meeting={m} joinable={canJoin(meetingPhase(m, nowMs))} />
                ))}
              </ul>
            </HomeCard>
          )}

          <HomeCard icon={Building2Icon} title={t('home.workspace')}>
            <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 px-5 py-4 text-[14px]">
              <dt className="text-muted-foreground">{t('general.name')}</dt>
              <dd className="font-medium">{org.name}</dd>
              <dt className="text-muted-foreground">{t('home.yourRole')}</dt>
              <dd>
                <Badge variant={roleStyle(workspace.role.key).tone}>
                  <RoleIcon />
                  {workspace.role.name}
                </Badge>
              </dd>
              {canViewMembers && (
                <>
                  <dt className="text-muted-foreground">{t('home.members')}</dt>
                  <dd>{members.data?.length ?? '…'}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('home.created')}</dt>
              <dd>{formatDate(org.createdAt)}</dd>
            </dl>
          </HomeCard>

          {canViewMembers && (
            <HomeCard icon={UserPlusIcon} title={t('home.newMembers')} action={<ViewAll to={`${settings}/users`} />}>
              <ul className="divide-y">
                {newest.map((m) => (
                  <li key={m.user.id} className="flex items-center gap-3 px-5 py-3">
                    <Avatar name={m.user.displayName} seed={m.user.id} size="md" online={m.user.id === me.user.id} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">{m.user.displayName}</p>
                      <p className="truncate text-[13px] text-muted-foreground">{m.role.name}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(m.joinedAt)}</span>
                  </li>
                ))}
              </ul>
            </HomeCard>
          )}
        </div>
      </div>
    </div>
  )
}

/** "Görevlerim" (mockup "Yeni 03"): the caller's next open tasks, ticked off in place. */
function MyTasksCard() {
  const t = useT()
  const { workspace } = useWorkspace()
  const tasks = useMyTasks()
  const toggle = useToggleDone()
  const links = useProjectLinks()
  const list = [...(tasks.data ?? [])].sort(compareForList).slice(0, 5)
  if (list.length === 0) return null
  return (
    <HomeCard icon={ListChecksIcon} title={t('home.myTasks')} action={<ViewAll to={`/w/${workspace.organization.slug}/tasks`} />}>
      <ul className="divide-y">
        {list.map((task) => {
          const done = task.status.category === 'done'
          return (
            <li key={task.id} className="flex items-center gap-4 px-5 py-3">
              <Checkbox
                checked={done}
                disabled={toggle.isPending}
                aria-label={done ? t('linked.reopen', { title: task.title }) : t('linked.complete', { title: task.title })}
                onCheckedChange={() => toggle.mutate(task)}
                className="size-5"
              />
              <Link to={links.task(task.project.id, task.id)} className="min-w-0 flex-1 outline-none hover:underline focus-visible:underline">
                <span className={cn('block truncate text-[14px] font-semibold', done && 'text-muted-foreground line-through')}>{task.title}</span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{task.key}</span>
                  <span className="truncate">{task.project.name}</span>
                  <DueDate task={task} />
                </span>
              </Link>
              {done ? <Badge variant="success">{t('tasks.done')}</Badge> : <PriorityBadge priority={task.priority} />}
            </li>
          )
        })}
      </ul>
      {toggle.error && <p className="px-5 pb-3 text-xs text-destructive">{errorMessage(toggle.error)}</p>}
    </HomeCard>
  )
}

function HomeCard({ icon: Icon, title, action, children }: { icon: LucideIcon; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-3 border-b px-5 py-4">
        <Icon className="size-5 text-primary" />
        <h2 className="flex-1 text-[16px] font-semibold">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

function ViewAll({ to }: { to: string }) {
  const t = useT()
  return (
    <Link to={to} className="flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
      {t('common.viewAll')}
      <ArrowRightIcon className="size-3.5" />
    </Link>
  )
}
