import type { Task } from '@fudislte/api-client'
import { Alert, Button, Spinner } from '@fudislte/ui'
import { ListChecksIcon } from 'lucide-react'
import { Link, useNavigate } from 'react-router'

import { type MessageKey, useT } from '../../i18n'
import { errorMessage } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { PageHeader } from '../../shell/PageHeader'
import { todayKey } from './filters'
import { useMyTasks, useProjectLinks } from './projects'
import { TaskRow } from './TaskViews'

type Group = 'overdue' | 'today' | 'week' | 'later' | 'undated' | 'done'

const groupLabels: Record<Group, MessageKey> = {
  overdue: 'myTasks.overdue',
  today: 'myTasks.today',
  week: 'myTasks.week',
  later: 'myTasks.later',
  undated: 'myTasks.undated',
  done: 'myTasks.done',
}

/** Sorts the caller's tasks into due-date groups. */
export function groupMyTasks(tasks: readonly Task[], now = new Date()): { group: Group; tasks: Task[] }[] {
  const today = todayKey(now)
  const week = todayKey(new Date(now.getTime() + 7 * 86_400_000))
  const of = (x: Task): Group => {
    if (x.status.category === 'done') return 'done'
    if (!x.dueOn) return 'undated'
    if (x.dueOn < today) return 'overdue'
    if (x.dueOn === today) return 'today'
    return x.dueOn <= week ? 'week' : 'later'
  }
  const order: Group[] = ['overdue', 'today', 'week', 'later', 'undated', 'done']
  return order.map((group) => ({ group, tasks: tasks.filter((x) => of(x) === group) })).filter((g) => g.tasks.length > 0)
}

/** /w/:slug/tasks — "Görevler": the caller's assigned tasks across projects. */
export function MyTasksPage() {
  const t = useT()
  const { workspace } = useWorkspace()
  const tasks = useMyTasks()
  const links = useProjectLinks()
  const navigate = useNavigate()
  return (
    <>
      <PageHeader icon={ListChecksIcon} title={t('myTasks.title')} description={t('myTasks.description')} />
      <div className="grid content-start gap-5 px-6 py-6">
        {tasks.isPending && (
          <div className="flex justify-center p-10">
            <Spinner label={t('common.loading')} />
          </div>
        )}
        {tasks.error && <Alert variant="error">{errorMessage(tasks.error)}</Alert>}
        {tasks.data?.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-12 text-center">
            <ListChecksIcon className="size-8 text-muted-foreground" />
            <p className="text-[15px] font-medium">{t('myTasks.empty')}</p>
            <p className="max-w-md text-[13px] text-muted-foreground">{t('myTasks.emptyHint')}</p>
            <Button variant="outline" className="mt-2" asChild>
              <Link to={`/w/${workspace.organization.slug}/projects`}>{t('nav.projects')}</Link>
            </Button>
          </div>
        )}
        {tasks.data &&
          groupMyTasks(tasks.data).map(({ group, tasks: list }) => (
            <section key={group} className="overflow-hidden rounded-xl border bg-card">
              <h2 className="flex items-center gap-2 border-b px-5 py-3 text-[14px] font-semibold">
                {t(groupLabels[group])}
                <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">{list.length}</span>
              </h2>
              <ul className="divide-y">
                {list.map((task) => (
                  <li key={task.id}>
                    <TaskRow task={task} onOpen={() => navigate(links.task(task.project.id, task.id))} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </>
  )
}
