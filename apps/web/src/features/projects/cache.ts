import type { Task, TaskDetail } from '@fudislte/api-client'
import type { QueryClient } from '@tanstack/react-query'

import { queryKeys } from '../../lib/api'

// Task changes applied to the query cache, from mutations and from live events
// (task.updated carries the task as everyone who may see the project sees it).

/** The list fields of a task, without the detail-only ones. */
export function summary(t: Task | TaskDetail): Task {
  const {
    description: _description,
    creator: _creator,
    checklistItems: _items,
    comments: _comments,
    links: _links,
    activity: _activity,
    ...rest
  } = t as TaskDetail
  return rest
}

/** Puts a task's new state into the project's list and every list that shows it. */
export function applyTask(qc: QueryClient, orgId: string, task: Task) {
  const t = summary(task)
  qc.setQueryData<Task[]>(queryKeys.projectTasks(orgId, t.project.id), (list) => {
    if (!list) return list
    const i = list.findIndex((x) => x.id === t.id)
    return i < 0 ? [...list, t] : list.map((x) => (x.id === t.id ? t : x))
  })
  for (const [key, list] of qc.getQueriesData<Task[]>({ queryKey: ['orgs', orgId, 'channel-tasks'] })) {
    if (list?.some((x) => x.id === t.id)) qc.setQueryData<Task[]>(key, list.map((x) => (x.id === t.id ? t : x)))
  }
}

export function removeTask(qc: QueryClient, orgId: string, projectId: string, taskId: string) {
  qc.setQueryData<Task[]>(queryKeys.projectTasks(orgId, projectId), (list) => list?.filter((x) => x.id !== taskId))
  for (const [key, list] of qc.getQueriesData<Task[]>({ queryKey: ['orgs', orgId, 'channel-tasks'] })) {
    if (list?.some((x) => x.id === taskId)) qc.setQueryData<Task[]>(key, list.filter((x) => x.id !== taskId))
  }
  qc.removeQueries({ queryKey: queryKeys.task(orgId, taskId) })
}

/** After a change of the caller's own: the detail, the lists and the counts. */
export function taskSaved(qc: QueryClient, orgId: string, task: TaskDetail) {
  qc.setQueryData(queryKeys.task(orgId, task.id), task)
  applyTask(qc, orgId, task)
  void qc.invalidateQueries({ queryKey: queryKeys.myTasks(orgId) })
  void qc.invalidateQueries({ queryKey: queryKeys.projectActivity(orgId, task.project.id) })
}
