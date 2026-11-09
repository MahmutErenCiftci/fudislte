import type { Board, BoardInput } from '@fudislte/api-client'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  Textarea,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'

import { useT } from '../../i18n'
import { api, fieldErrors, formError, queryKeys } from '../../lib/api'
import { can } from '../../lib/permissions'
import { useWorkspace } from '../../shell/context'
import { useProjects } from '../projects/projects'
import { useRooms } from '../rooms/rooms'

/** Creates a board (workspace or project), or edits one: title, description, voice room. */
export function BoardDialog({
  open,
  onOpenChange,
  board,
  projectId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  board?: Board
  /** Preselects a project for a new board. */
  projectId?: string
  onSaved?: (board: Board) => void
}) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const projects = useProjects()
  const rooms = useRooms()
  const blank = () => ({
    title: board?.title ?? '',
    description: board?.description ?? '',
    projectId: board?.project?.id ?? projectId ?? '',
    roomId: board?.room?.id ?? '',
  })
  const [form, setForm] = useState(blank)
  const [shown, setShown] = useState(open)
  if (open !== shown) {
    setShown(open)
    if (open) setForm(blank())
  }
  const editableProjects = (projects.data ?? []).filter((p) => p.canEdit)
  const admittedRooms = (rooms.data ?? []).filter((r) => r.admitted)
  const save = useMutation({
    mutationFn: (input: BoardInput) => (board ? api.updateBoard(orgId, board.id, input) : api.createBoard(orgId, input)),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: queryKeys.boards(orgId) })
      onSaved?.(saved)
      close()
      if (!board) navigate(`/w/${workspace.organization.slug}/b/${saved.id}`)
    },
  })
  const close = () => {
    onOpenChange(false)
    save.reset()
  }
  const errors = fieldErrors(save.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate({
      title: form.title,
      description: form.description,
      roomId: form.roomId || null,
      ...(!board && form.projectId && { projectId: form.projectId }),
    })
  }
  const canWorkspace = can(workspace, 'boards.create')
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{board ? t('boards.editTitle') : t('boards.createTitle')}</DialogTitle>
            <DialogDescription>{t('boards.createDescription')}</DialogDescription>
          </DialogHeader>
          {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
          <Field label={t('boards.titleLabel')} error={errors.title}>
            <Input
              autoFocus
              maxLength={120}
              placeholder={t('boards.titlePlaceholder')}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label={t('boards.descriptionLabel')} error={errors.description}>
            <Textarea rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          {!board && (
            <Field label={t('boards.project')} error={errors.projectId} hint={t('boards.projectHint')}>
              <NativeSelect value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                {canWorkspace && <option value="">{t('boards.workspaceBoard')}</option>}
                {editableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label={t('boards.room')} error={errors.roomId} hint={t('boards.roomHint')}>
            <NativeSelect value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
              <option value="">{t('boards.noRoom')}</option>
              {board?.room && !admittedRooms.some((r) => r.id === board.room?.id) && <option value={board.room.id}>{board.room.name}</option>}
              {admittedRooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending || !form.title.trim() || (!board && !canWorkspace && !form.projectId)}>
              {board ? t('common.save') : t('boards.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
