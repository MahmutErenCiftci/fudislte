import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
} from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, PlusIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'

import { useT } from '../i18n'
import { api, fieldErrors, formError, queryKeys } from '../lib/api'
import { useWorkspace } from './context'

function WorkspaceMark({ name }: { name: string }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-[15px] font-bold text-primary-foreground">
      {Array.from(name)[0]?.toLocaleUpperCase('tr')}
    </span>
  )
}

/** Workspace card at the top of the sidebar; switches between workspaces. */
export function WorkspaceSwitcher() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const org = workspace.organization

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="panel flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
            <WorkspaceMark name={org.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold">{org.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{window.location.host}</span>
            </span>
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{t('shell.workspaces')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={org.id}
            onValueChange={(id) => {
              const target = me.workspaces.find((w) => w.organization.id === id)
              if (target) navigate(`/w/${target.organization.slug}`)
            }}
          >
            {me.workspaces.map((w) => (
              <DropdownMenuRadioItem key={w.organization.id} value={w.organization.id}>
                <span className="truncate">{w.organization.name}</span>
                <span className="ml-auto pl-2 text-xs text-muted-foreground">{w.role.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {me.user.isInstanceAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
                <PlusIcon />
                {t('shell.newWorkspace')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  )
}

export function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => api.createOrganization(name),
    onSuccess: async (org) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      onOpenChange(false)
      setName('')
      navigate(`/w/${org.slug}`)
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) create.reset()
      }}
    >
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('shell.newWorkspace')}</DialogTitle>
            <DialogDescription>{t('shell.newWorkspaceDescription')}</DialogDescription>
          </DialogHeader>
          {formError(create.error) && <Alert variant="error">{formError(create.error)}</Alert>}
          <Field label={t('common.name')} error={fieldErrors(create.error).name}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || name.trim().length < 2}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
