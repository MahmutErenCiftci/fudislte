import type { Channel } from '@fudislte/api-client'
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Spinner } from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, queryKeys } from '../../lib/api'
import { useWorkspace } from '../../shell/context'
import { ChannelIcon } from './ChannelSidebar'
import { searchKey } from '../../lib/search'

export function BrowseChannelsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const { workspace } = useWorkspace()
  const orgId = workspace.organization.id
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const channels = useQuery({
    queryKey: queryKeys.browseChannels(orgId),
    queryFn: () => api.browseChannels(orgId),
    enabled: open,
  })
  const openChannel = (c: Channel) => {
    onOpenChange(false)
    setQuery('')
    navigate(`/w/${workspace.organization.slug}/c/${c.id}`)
  }
  const join = useMutation({
    mutationFn: (c: Channel) => api.joinChannel(orgId, c.id),
    onSuccess: async (c) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.channels(orgId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels(orgId) })
      openChannel(c)
    },
  })

  const q = searchKey(query.trim())
  const visible = (channels.data ?? []).filter((c) => !q || searchKey(`${c.name} ${c.topic}`).includes(q))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('chat.browse')}</DialogTitle>
          <DialogDescription>{t('chat.browseDescription')}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          icon={<SearchIcon />}
          aria-label={t('chat.browseSearch')}
          placeholder={t('chat.browseSearch')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {join.error && <Alert variant="error">{errorMessage(join.error)}</Alert>}
        <div className="max-h-96 min-h-24 overflow-y-auto rounded-lg border">
          {channels.isPending && (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          )}
          {channels.error && <p className="p-3 text-[13px] text-destructive">{errorMessage(channels.error)}</p>}
          {channels.data && visible.length === 0 && (
            <p className="p-6 text-center text-[13px] text-muted-foreground">{t('chat.browseEmpty')}</p>
          )}
          <ul className="divide-y">
            {visible.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                <button
                  onClick={() => openChannel(c)}
                  className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <ChannelIcon channel={c} className="mt-0.5 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t('chat.members', { count: c.memberCount })}
                      {c.topic && ` · ${c.topic}`}
                    </span>
                  </span>
                </button>
                {c.archivedAt ? (
                  <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{t('archive.label')}</span>
                ) : c.joined ? (
                  <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <CheckIcon className="size-3.5" />
                    {t('chat.joined')}
                  </span>
                ) : (
                  <Button size="sm" variant="outline" disabled={join.isPending} onClick={() => join.mutate(c)}>
                    {t('chat.browseJoin')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  )
}
