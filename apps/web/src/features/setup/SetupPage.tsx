import { Alert, Button, Checkbox, Field, Input } from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRightIcon, KeyRoundIcon, MailIcon } from 'lucide-react'
import { type ChangeEvent, type FormEvent, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { useMeta } from '../../lib/session'
import { AuthLayout, FullScreenMessage } from '../auth/AuthLayout'
import { CodeInput, isCompleteCode, ResendCode } from '../auth/CodeInput'

/**
 * First-run setup. Step 1 checks the setup token and emails a code to the future owner,
 * which also proves the server can send sign-in codes. Step 2 creates the workspace.
 */
export function SetupPage() {
  const t = useT()
  const meta = useMeta()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<'start' | 'details'>('start')
  const [form, setForm] = useState({ setupToken: '', email: '', organizationName: '', displayName: '', code: '' })
  // Consent must be given actively: the box starts unchecked.
  const [share, setShare] = useState(false)

  const sendCode = useMutation({
    mutationFn: () => api.setupCode(form.setupToken, form.email),
    onSuccess: () => setStep('details'),
  })
  const setup = useMutation({
    mutationFn: () => api.setup({ ...form, shareRegistration: share && meta.data?.registrationAvailable === true }),
    onSuccess: async ({ organization }) => {
      queryClient.setQueryData(queryKeys.meta, (m: typeof meta.data) => (m ? { ...m, setupRequired: false } : m))
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      navigate(`/w/${organization.slug}`, { replace: true })
    },
  })

  if (meta.isPending) return <FullScreenMessage>{t('common.loading')}</FullScreenMessage>
  if (meta.data && !meta.data.setupRequired) return <Navigate to="/" replace />

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value })

  if (step === 'start') {
    const errors = fieldErrors(sendCode.error)
    const submit = (e: FormEvent) => {
      e.preventDefault()
      sendCode.mutate()
    }
    return (
      <AuthLayout title={t('setup.title')} description={t('setup.description')}>
        <form className="grid gap-5" onSubmit={submit} noValidate>
          {formError(sendCode.error) && <Alert variant="error">{formError(sendCode.error)}</Alert>}
          <Field label={t('setup.token')} error={errors.setupToken} hint={t('setup.tokenHint')}>
            <Input
              icon={<KeyRoundIcon />}
              className="h-11 font-mono"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={form.setupToken}
              onChange={set('setupToken')}
            />
          </Field>
          <Field label={t('setup.email')} error={errors.email} hint={t('setup.emailHint')}>
            <Input icon={<MailIcon />} className="h-11" type="email" autoComplete="email" value={form.email} onChange={set('email')} />
          </Field>
          <Button type="submit" size="lg" className="h-11" disabled={sendCode.isPending || !form.setupToken || !form.email}>
            {t('setup.sendCode')}
            <ArrowRightIcon />
          </Button>
        </form>
      </AuthLayout>
    )
  }

  const errors = fieldErrors(setup.error)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setup.mutate()
  }
  return (
    <AuthLayout title={t('setup.createTitle')} description={t('setup.codeSent', { email: form.email })}>
      <form className="grid gap-5" onSubmit={submit} noValidate>
        {(formError(setup.error) || sendCode.error) && (
          <Alert variant="error">{formError(setup.error) ?? errorMessage(sendCode.error)}</Alert>
        )}
        <Field label={t('setup.code')}>
          <CodeInput autoFocus value={form.code} onChange={(code) => setForm({ ...form, code })} />
        </Field>
        <Field label={t('setup.workspaceName')} error={errors.organizationName}>
          <Input className="h-11" placeholder={t('setup.workspacePlaceholder')} value={form.organizationName} onChange={set('organizationName')} />
        </Field>
        <Field label={t('login.yourName')} error={errors.displayName}>
          <Input className="h-11" autoComplete="name" value={form.displayName} onChange={set('displayName')} />
        </Field>
        {meta.data?.registrationAvailable && (
          <label htmlFor="share-registration" className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-[13px]">
            <Checkbox id="share-registration" className="mt-0.5" checked={share} onCheckedChange={(v) => setShare(v === true)} />
            <span className="grid gap-0.5">
              <span className="font-medium">{t('setup.shareTitle')}</span>
              <span className="text-muted-foreground">{t('setup.shareText')}</span>
            </span>
          </label>
        )}
        <Button type="submit" size="lg" className="h-11" disabled={setup.isPending || !isCompleteCode(form.code)}>
          {setup.isPending ? t('setup.creating') : t('setup.create')}
        </Button>
        <div className="flex items-center justify-between text-[13px]">
          <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground" onClick={() => setStep('start')}>
            {t('setup.changeEmail')}
          </Button>
          <ResendCode onResend={() => sendCode.mutate()} disabled={sendCode.isPending} />
        </div>
        <p className="text-center text-xs text-muted-foreground">{t('setup.ownerNote')}</p>
      </form>
    </AuthLayout>
  )
}
