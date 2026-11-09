import { getPlatform, type DisplayPickRequest } from '@fudislte/platform'
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@fudislte/ui'
import { useEffect, useState } from 'react'

import { useT } from '../../i18n'
import { getVoice } from './voice'

/**
 * Desktop app only: when the page starts a screen share, the shell lists the screens and
 * windows and this dialog lets the person pick one. Nothing is shared without a pick.
 */
export function DisplayPicker() {
  const t = useT()
  const desktop = getPlatform().desktop
  const [request, setRequest] = useState<DisplayPickRequest | null>(null)
  const [kind, setKind] = useState<'screen' | 'window'>('screen')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(
    () =>
      desktop?.onDisplayPick((r) => {
        setRequest(r)
        setKind('screen')
        setSelected(r.sources.find((s) => s.kind === 'screen')?.id ?? null)
      }),
    [desktop],
  )
  if (!desktop || !request) return null

  const answer = (sourceId: string | null) => {
    void desktop.chooseDisplaySource(request.id, sourceId)
    setRequest(null)
  }
  const sources = request.sources.filter((s) => s.kind === kind)

  return (
    <Dialog open onOpenChange={(open) => !open && answer(null)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('voice.pickTitle')}</DialogTitle>
          <DialogDescription>{getVoice().target?.kind === 'meeting' ? t('voice.pickTextMeeting') : t('voice.pickText')}</DialogDescription>
        </DialogHeader>
        <nav className="flex gap-1 border-b">
          {(['screen', 'window'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-current={kind === k ? 'page' : undefined}
              onClick={() => setKind(k)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium outline-none',
                kind === k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {k === 'screen' ? t('voice.pickScreens') : t('voice.pickWindows')}
            </button>
          ))}
        </nav>
        <ul className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
          {sources.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                onDoubleClick={() => answer(s.id)}
                aria-pressed={selected === s.id}
                className={cn(
                  'grid w-full gap-1.5 rounded-lg border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                  selected === s.id ? 'border-primary bg-primary-soft/60' : 'hover:bg-accent/60',
                )}
              >
                <img src={s.thumbnail} alt="" className="aspect-video w-full rounded bg-muted object-contain" />
                <span className="truncate text-xs font-medium">{s.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(null)}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!selected || !sources.some((s) => s.id === selected)} onClick={() => answer(selected)}>
            {t('voice.pickShare')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
