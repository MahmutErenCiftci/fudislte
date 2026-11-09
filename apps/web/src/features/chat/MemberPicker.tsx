import { Avatar, Checkbox, Input, Spinner } from '@fudislte/ui'
import { useQuery } from '@tanstack/react-query'
import { SearchIcon } from 'lucide-react'
import { useId, useState } from 'react'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { searchKey } from '../../lib/search'

/** Multi-select list of workspace members. Needs the members.view permission. */
export function MemberPicker({
  selected,
  onChange,
  exclude = [],
  max,
}: {
  selected: string[]
  onChange: (ids: string[]) => void
  /** People already in the channel. */
  exclude?: string[]
  /** Most people that can be selected. */
  max?: number
}) {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const members = useQuery({ queryKey: queryKeys.members(orgId), queryFn: () => api.members(orgId) })
  const [query, setQuery] = useState('')
  const id = useId()

  const q = searchKey(query.trim())
  const candidates = (members.data ?? []).filter(
    (m) =>
      m.user.id !== me.user.id &&
      !exclude.includes(m.user.id) &&
      (!q || searchKey(m.user.displayName).includes(q) || searchKey(m.user.email).includes(q)),
  )
  const toggle = (userId: string, on: boolean) =>
    onChange(on ? [...selected, userId] : selected.filter((s) => s !== userId))
  const full = max !== undefined && selected.length >= max

  return (
    <div className="grid gap-2">
      <Input
        icon={<SearchIcon />}
        aria-label={t('people.search')}
        placeholder={t('people.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="max-h-52 overflow-y-auto rounded-lg border">
        {members.isPending && (
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        )}
        {members.error && <p className="p-3 text-[13px] text-destructive">{errorMessage(members.error)}</p>}
        {members.data && candidates.length === 0 && (
          <p className="p-4 text-center text-[13px] text-muted-foreground">{t('chat.pickerEmpty')}</p>
        )}
        <ul className="divide-y">
          {candidates.map((m) => {
            const checkboxId = `${id}-${m.user.id}`
            return (
              <li key={m.user.id}>
                <label htmlFor={checkboxId} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/60">
                  <Checkbox
                    id={checkboxId}
                    checked={selected.includes(m.user.id)}
                    disabled={full && !selected.includes(m.user.id)}
                    onCheckedChange={(v) => toggle(m.user.id, v === true)}
                  />
                  <Avatar name={m.user.displayName} seed={m.user.id} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{m.user.displayName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {m.role.name} · {m.user.email}
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      </div>
      {selected.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('chat.pickerSelected', { count: selected.length })}
          {full && ` · ${t('dm.tooMany')}`}
        </p>
      )}
    </div>
  )
}
