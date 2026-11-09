import { Spinner } from '@fudislte/ui'
import { AudioLinesIcon, VideoIcon, XIcon } from 'lucide-react'
import { Link } from 'react-router'

import { useT } from '../../i18n'
import { voicePath } from './target'
import { VoiceControls } from './VoicePanel'
import { clearVoiceError, useVoice } from './voice'

/** Bottom of the sidebar: the current call, of a room or a meeting, on every page. */
export function VoiceDock() {
  const t = useT()
  const voice = useVoice()
  if (voice.status === 'idle' || !voice.target) {
    if (!voice.error) return null
    return (
      <div className="mt-auto flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-[13px] text-destructive">
        <p className="flex-1">{voice.error}</p>
        <button type="button" aria-label={t('common.close')} onClick={clearVoiceError} className="rounded p-0.5 hover:bg-destructive/10">
          <XIcon className="size-4" />
        </button>
      </div>
    )
  }
  const meeting = voice.target.kind === 'meeting'
  const Icon = meeting ? VideoIcon : AudioLinesIcon
  return (
    <section aria-label={meeting ? t('meetings.call') : t('voice.title')} className="mt-auto grid gap-2 rounded-xl border bg-card p-3 shadow-sm">
      <div className="flex items-center gap-2">
        {voice.status === 'connected' ? (
          <span className="flex size-2.5 shrink-0 rounded-full bg-emerald-500" />
        ) : (
          <Spinner className="size-3.5" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            {voice.status === 'connected' ? t('voice.connected') : t('voice.connecting')}
          </p>
          <Link to={voicePath(voice.target)} className="flex items-center gap-1 truncate text-[13px] font-medium hover:underline">
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{voice.target.name}</span>
          </Link>
        </div>
      </div>
      {voice.status === 'connected' && <VoiceControls compact />}
    </section>
  )
}
