import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@fudislte/ui'
import { ChevronDownIcon, GlobeIcon } from 'lucide-react'

import { isLanguage, type Language, languages, useLanguage, useT } from '../i18n'

/** Compact language picker, e.g. on the sign-in screen. */
export function LanguageMenu({ onChange }: { onChange: (language: Language) => void }) {
  const t = useT()
  const language = useLanguage()
  const current = languages.find((l) => l.code === language)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t('language.label')} className="text-muted-foreground">
          <GlobeIcon />
          {current?.label}
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup value={language} onValueChange={(v) => isLanguage(v) && onChange(v)}>
          {languages.map((l) => (
            <DropdownMenuRadioItem key={l.code} value={l.code}>
              {l.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
