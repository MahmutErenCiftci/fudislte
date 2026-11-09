import type { Attachment, Person } from '@fudislte/api-client'
import { Avatar, Button, cn } from '@fudislte/ui'
import { PaperclipIcon, SendHorizontalIcon } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useT } from '../../i18n'
import { errorMessage } from '../../lib/api'
import { type PendingUpload, PendingUploads } from './Attachments'
import { mentionQuery, toMentionTokens } from './text'
import { useTyping } from './typing'
import { searchKey } from '../../lib/search'

const MAX_FILES = 10
const MAX_LENGTH = 4000
const MAX_HEIGHT_PX = 200
const MAX_SUGGESTIONS = 6
const TYPING_EVERY_MS = 3_000

/** Unsent text per channel or thread, with the mentions chosen in it. */
const drafts = new Map<string, { text: string; names: Map<string, string> }>()

interface ComposerProps {
  /** Key for the draft: a channel ID, or a thread's root ID. */
  draftKey: string
  placeholder: string
  /** People who can be mentioned with "@". */
  people?: Person[]
  /** Resolves once the message is stored; the draft is cleared only then. */
  onSend: (body: string, attachmentIds: string[]) => Promise<unknown>
  /** Uploads a file for the next message; without it the composer takes text only. */
  onUpload?: (file: File) => Promise<Attachment>
  /** Removes an upload that will not be sent. */
  onDiscard?: (attachmentId: string) => void
  /** ↑ in an empty composer edits the user's last message. */
  onEditLast?: () => void
  autoFocus?: boolean
  compact?: boolean
  /** Called while the person types, at most every few seconds. */
  onTyping?: () => void
  /**
   * Where to show who else is typing: a channel, or a thread in it. Read here rather than
   * passed in, so typing events re-render only the composer.
   */
  typingIn: { channelId: string; parentId?: string }
}

export function Composer({
  draftKey,
  placeholder,
  people = [],
  onSend,
  onUpload,
  onDiscard,
  onEditLast,
  autoFocus = true,
  compact,
  onTyping,
  typingIn,
}: ComposerProps) {
  const t = useT()
  const typing = useTyping(typingIn.channelId, typingIn.parentId)
  const [uploads, setUploads] = useState<PendingUpload[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const ready = uploads.filter((u) => u.attachment).map((u) => u.attachment!.id)
  const uploading = uploads.some((u) => !u.attachment && !u.error)

  const addFiles = (files: Iterable<File>) => {
    if (!onUpload) return
    for (const file of [...files].slice(0, MAX_FILES - uploads.length)) {
      const key = crypto.randomUUID()
      setUploads((list) => [...list, { key, name: file.name || 'file', size: file.size }])
      onUpload(file).then(
        (attachment) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, attachment } : u))),
        (err: unknown) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, error: errorMessage(err) } : u))),
      )
    }
  }
  const removeUpload = (key: string) => {
    const u = uploads.find((x) => x.key === key)
    if (u?.attachment) onDiscard?.(u.attachment.id)
    setUploads((list) => list.filter((x) => x.key !== key))
  }
  const saved = drafts.get(draftKey)
  const [value, setValue] = useState(saved?.text ?? '')
  const names = useRef(saved?.names ?? new Map<string, string>())
  const [sending, setSending] = useState(false)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const lastTyping = useRef(0)

  useEffect(() => {
    // An empty draft is the default; keeping one per channel ever opened only grows.
    if (value) drafts.set(draftKey, { text: value, names: names.current })
    else drafts.delete(draftKey)
  }, [draftKey, value])

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value])

  const q = mention ? searchKey(mention.query) : ''
  // Any word of the name may match: "@yıl" finds "Ali Yılmaz".
  const suggestions = mention
    ? people.filter((p) => searchKey(p.displayName).split(/\s+/).some((w) => w.startsWith(q))).slice(0, MAX_SUGGESTIONS)
    : []

  const updateMention = (el: HTMLTextAreaElement) => {
    setMention(mentionQuery(el.value.slice(0, el.selectionStart)))
    setActive(0)
  }

  const choose = (person: Person) => {
    const el = input.current
    if (!el || !mention) return
    const insert = `@${person.displayName} `
    const next = value.slice(0, mention.start) + insert + value.slice(el.selectionStart)
    names.current.set(person.displayName, person.id)
    setValue(next)
    setMention(null)
    const caret = mention.start + insert.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const submit = async () => {
    const text = value.trim()
    if ((!text && ready.length === 0) || uploading || sending || text.length > MAX_LENGTH) return
    setSending(true)
    try {
      await onSend(toMentionTokens(text, names.current), ready)
      setValue('')
      setUploads([])
      names.current = new Map()
    } catch {
      // The page shows the error; the draft stays so nothing is lost.
    } finally {
      setSending(false)
      input.current?.focus()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
        e.preventDefault()
        choose(suggestions[active]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'ArrowUp' && value === '' && onEditLast) {
      e.preventDefault()
      onEditLast()
    }
  }

  const tooLong = value.length > MAX_LENGTH
  return (
    <div className={cn('relative shrink-0 pt-1', compact ? 'px-4 pb-3' : 'px-6 pb-4')}>
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label={t('chat.mentionSomeone')}
          className={cn(
            'absolute bottom-full z-10 mb-1 w-72 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg',
            compact ? 'left-4' : 'left-6',
          )}
        >
          {suggestions.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()} // keep the caret in the textarea
                onMouseMove={() => setActive(i)}
                onClick={() => choose(p)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]',
                  i === active && 'bg-primary-soft text-primary-soft-foreground',
                )}
              >
                <Avatar name={p.displayName} seed={p.id} size="xs" />
                <span className="truncate font-medium">{p.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        onDragOver={(e) => {
          if (!onUpload || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!onUpload) return
          e.preventDefault()
          setDragging(false)
          addFiles(e.dataTransfer.files)
        }}
        className={cn(
          'rounded-xl border bg-card p-1.5 shadow-[var(--shadow-panel)] transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20',
          dragging && 'border-primary bg-primary-soft/40',
        )}
      >
        <PendingUploads uploads={uploads} onRemove={removeUpload} />
        <div className="flex items-end gap-1.5">
        {onUpload && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 rounded-lg text-muted-foreground"
              aria-label={t('files.attach')}
              disabled={uploads.length >= MAX_FILES}
              onClick={() => fileInput.current?.click()}
            >
              <PaperclipIcon className="size-4" />
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </>
        )}
        <textarea
          ref={input}
          autoFocus={autoFocus}
          rows={1}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            updateMention(e.target)
            if (onTyping && e.target.value.trim() && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
              lastTyping.current = Date.now()
              onTyping()
            }
          }}
          onSelect={(e) => updateMention(e.currentTarget)}
          onBlur={() => setMention(null)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (onUpload && e.clipboardData.files.length > 0) {
              e.preventDefault()
              addFiles(e.clipboardData.files)
            }
          }}
          className={cn(
            'max-h-[200px] min-h-9 flex-1 resize-none bg-transparent py-2 text-[14px] leading-5 outline-none placeholder:text-muted-foreground',
            !onUpload && 'pl-1.5',
          )}
        />
        <Button
          size="icon"
          className="size-9 shrink-0 rounded-lg"
          aria-label={t('chat.send')}
          disabled={(!value.trim() && ready.length === 0) || uploading || sending || tooLong}
          onClick={() => void submit()}
        >
          <SendHorizontalIcon className="size-4" />
        </Button>
        </div>
      </div>
      <p className="mt-1.5 flex justify-between px-1 text-[11px] text-muted-foreground">
        {typing.length > 0 ? (
          <span aria-live="polite" className="font-medium text-foreground/70">
            {typingText(typing, t)}
          </span>
        ) : (
          <span>{compact ? t('chat.mentionHint') : `${t('chat.composerHint')} · ${t('chat.mentionHint')}`}</span>
        )}
        {value.length > MAX_LENGTH - 500 && (
          <span className={cn(tooLong && 'font-medium text-destructive')}>{t('chat.counter', { count: value.length })}</span>
        )}
      </p>
    </div>
  )
}

/** "Ayşe yazıyor…", "Ayşe ve Mehmet yazıyor…", "Birkaç kişi yazıyor…". */
function typingText(names: string[], t: ReturnType<typeof useT>): string {
  if (names.length === 1) return t('typing.one', { name: names[0]! })
  if (names.length === 2) return t('typing.two', { a: names[0]!, b: names[1]! })
  return t('typing.many')
}
