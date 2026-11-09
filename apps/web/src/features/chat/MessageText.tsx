import type { Person } from '@fudislte/api-client'
import { cn, Tooltip } from '@fudislte/ui'
import { CheckIcon, CopyIcon, FileCodeIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useT } from '../../i18n'
import { parseMessage } from './text'

/**
 * Renders message text as React nodes: paragraphs, links, mentions, inline code and code
 * blocks.
 */
export function MessageText({ body, mentions = [], meId }: { body: string; mentions?: Person[]; meId?: string }) {
  const t = useT()
  const blocks = useMemo(() => parseMessage(body), [body])
  return (
    <div className="grid gap-2">
      {blocks.map((b, i) =>
        b.type === 'code' ? (
          <CodeBlock key={i} language={b.language} code={b.code} />
        ) : (
          <p key={i} className="break-words whitespace-pre-wrap">
            {b.parts.map((p, j) =>
              p.type === 'link' ? (
                <a
                  key={j}
                  href={p.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-2 [overflow-wrap:anywhere] hover:underline"
                >
                  {p.text}
                </a>
              ) : p.type === 'code' ? (
                <code key={j} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[12.5px]">
                  {p.text}
                </code>
              ) : p.type === 'mention' ? (
                <span
                  key={j}
                  className={cn(
                    'rounded px-0.5 font-medium',
                    p.userId === meId ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200' : 'bg-primary-soft text-primary',
                  )}
                >
                  @{mentions.find((m) => m.id === p.userId)?.displayName ?? t('chat.unknownPerson')}
                </span>
              ) : (
                p.text
              ),
            )}
          </p>
        ),
      )}
    </div>
  )
}

const languageNames: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  go: 'Go',
  py: 'Python',
  python: 'Python',
  sql: 'SQL',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  sh: 'Shell',
  bash: 'Shell',
  html: 'HTML',
  css: 'CSS',
  cs: 'C#',
  java: 'Java',
  rust: 'Rust',
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const lines = code.split('\n')
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <figure className="max-w-3xl overflow-hidden rounded-lg border bg-card">
      <figcaption className="flex h-9 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <FileCodeIcon className="size-4 text-primary" />
        <span className="flex-1 font-medium">{languageNames[language.toLowerCase()] ?? (language || t('chat.code'))}</span>
        <Tooltip content={t('chat.copyCode')} side="top">
          <button
            aria-label={t('chat.copyCode')}
            onClick={copy}
            className="flex size-7 items-center justify-center rounded-md outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
          </button>
        </Tooltip>
      </figcaption>
      <pre className="overflow-x-auto bg-slate-900 py-3 font-mono text-[12.5px] leading-5 text-slate-100">
        <code className="grid">
          {lines.map((line, i) => (
            <span key={i} className="flex">
              <span aria-hidden="true" className="w-10 shrink-0 pr-3 text-right text-slate-500 select-none">
                {i + 1}
              </span>
              <span className="pr-4">{line || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </figure>
  )
}
