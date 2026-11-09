import { Button, Input } from '@fudislte/ui'
import { type ComponentProps, useEffect, useState } from 'react'

import { useT } from '../../i18n'

/** Formats typed or pasted digits as "1234 5678". */
export function formatCodeInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8)
  return digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits
}

export const isCompleteCode = (value: string) => value.replace(/\D/g, '').length === 8

type CodeInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
}

/** Input for the 8-digit one-time codes FUDISLTE emails. */
export function CodeInput({ value, onChange, ...props }: CodeInputProps) {
  return (
    <Input
      inputMode="numeric"
      autoComplete="one-time-code"
      spellCheck={false}
      placeholder="1234 5678"
      maxLength={9}
      className="h-12 text-center font-mono text-xl tracking-[0.3em]"
      value={value}
      onChange={(e) => onChange(formatCodeInput(e.target.value))}
      {...props}
    />
  )
}

/** "Send a new code" with a short cooldown so people do not hit the server's rate limit. */
export function ResendCode({ onResend, disabled }: { onResend: () => void; disabled?: boolean }) {
  const t = useT()
  const [remaining, setRemaining] = useState(30)
  useEffect(() => {
    if (remaining <= 0) return
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000)
    return () => clearTimeout(timer)
  }, [remaining])
  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto px-0"
      disabled={disabled || remaining > 0}
      onClick={() => {
        onResend()
        setRemaining(30)
      }}
    >
      {remaining > 0 ? t('code.resendIn', { seconds: remaining }) : t('code.resend')}
    </Button>
  )
}
