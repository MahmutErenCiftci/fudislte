import { Alert, Button, Field, Input } from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRightIcon, KeyRoundIcon, MailIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { safeNext, useMe, useMeta } from '../../lib/session'
import { AuthLayout } from './AuthLayout'
import { CodeInput, isCompleteCode, ResendCode } from './CodeInput'

type Step = 'email' | 'code' | 'name' | 'key'

/** Keys are 20 characters; dashes and spaces are only for readability. */
const isCompleteKey = (key: string) => key.replace(/[\s-]/g, '').length === 20

/**
 * Passwordless sign-in: enter a work email, then the one-time code sent to it.
 * People joining through their company's domain confirm their name afterwards.
 * People whose account IT prepared enter their access key instead (?key=1 opens that).
 */
export function LoginPage() {
  const t = useT()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const meta = useMeta()
  const me = useMe()
  const [step, setStep] = useState<Step>(params.get('key') ? 'key' : 'email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [accessKey, setAccessKey] = useState('')

  const redeem = useMutation({
    mutationFn: () => api.redeemAccessKey(accessKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      navigate(next, { replace: true })
    },
  })

  const requestCode = useMutation({
    mutationFn: () => api.requestCode(email),
    onSuccess: () => {
      setCode('')
      setStep('code')
    },
  })
  const verify = useMutation({
    mutationFn: () => api.verifyCode(email, code),
    onSuccess: async ({ user, newAccount }) => {
      if (newAccount) {
        setDisplayName(user.displayName)
        setStep('name')
        return
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      navigate(next, { replace: true })
    },
  })
  const saveName = useMutation({
    mutationFn: () => api.updateProfile({ displayName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      navigate(next, { replace: true })
    },
  })

  if (meta.data?.setupRequired) return <Navigate to="/setup" replace />
  // While confirming the name the session already exists; stay on this page until done.
  if (me.data && step !== 'name') return <Navigate to={next} replace />

  if (step === 'name') {
    const submit = (e: FormEvent) => {
      e.preventDefault()
      saveName.mutate()
    }
    return (
      <AuthLayout title={t('login.welcome')} description={t('login.welcomeText')}>
        <form className="grid gap-5" onSubmit={submit} noValidate>
          {formError(saveName.error) && <Alert variant="error">{formError(saveName.error)}</Alert>}
          <Field label={t('login.yourName')} error={fieldErrors(saveName.error).displayName}>
            <Input className="h-11" autoComplete="name" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Button type="submit" size="lg" className="h-11" disabled={saveName.isPending || !displayName.trim()}>
            {t('common.continue')}
            <ArrowRightIcon />
          </Button>
        </form>
      </AuthLayout>
    )
  }

  if (step === 'key') {
    const submit = (e: FormEvent) => {
      e.preventDefault()
      redeem.mutate()
    }
    return (
      <AuthLayout title={t('login.keyTitle')} description={t('login.keyDescription')}>
        <form className="grid gap-5" onSubmit={submit} noValidate>
          {redeem.error && <Alert variant="error">{errorMessage(redeem.error)}</Alert>}
          <Field label={t('login.key')}>
            <Input
              icon={<KeyRoundIcon />}
              className="h-11 font-mono tracking-wider uppercase"
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
            />
          </Field>
          <Button type="submit" size="lg" className="h-11" disabled={redeem.isPending || !isCompleteKey(accessKey)}>
            {redeem.isPending ? t('login.opening') : t('login.openWithKey')}
            {!redeem.isPending && <ArrowRightIcon />}
          </Button>
          <p className="text-center text-[13px] text-muted-foreground">{t('login.keyHint')}</p>
          <Button
            variant="link"
            size="sm"
            className="h-auto justify-self-center px-0 text-muted-foreground"
            onClick={() => {
              redeem.reset()
              setStep('email')
            }}
          >
            <MailIcon />
            {t('login.useEmail')}
          </Button>
        </form>
      </AuthLayout>
    )
  }

  if (step === 'code') {
    const submit = (e: FormEvent) => {
      e.preventDefault()
      verify.mutate()
    }
    return (
      <AuthLayout title={t('login.checkEmail')} description={t('login.codeSent', { email })}>
        <form className="grid gap-5" onSubmit={submit} noValidate>
          {(verify.error || requestCode.error) && <Alert variant="error">{errorMessage(verify.error ?? requestCode.error)}</Alert>}
          <Field label={t('login.code')}>
            <CodeInput autoFocus value={code} onChange={setCode} />
          </Field>
          <Button type="submit" size="lg" className="h-11" disabled={verify.isPending || !isCompleteCode(code)}>
            {verify.isPending ? t('login.signingIn') : t('login.signIn')}
            {!verify.isPending && <ArrowRightIcon />}
          </Button>
          <div className="flex items-center justify-between text-[13px]">
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-muted-foreground"
              onClick={() => {
                verify.reset()
                setStep('email')
              }}
            >
              {t('login.differentEmail')}
            </Button>
            <ResendCode onResend={() => requestCode.mutate()} disabled={requestCode.isPending} />
          </div>
        </form>
      </AuthLayout>
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    requestCode.mutate()
  }
  return (
    <AuthLayout title={t('login.title')} description={t('login.description')}>
      <form className="grid gap-5" onSubmit={submit} noValidate>
        {formError(requestCode.error) && <Alert variant="error">{formError(requestCode.error)}</Alert>}
        <Field label={t('login.email')} error={fieldErrors(requestCode.error).email}>
          <Input
            icon={<MailIcon />}
            className="h-11"
            type="email"
            autoComplete="email"
            autoFocus
            placeholder={t('login.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Button type="submit" size="lg" className="h-11" disabled={requestCode.isPending || !email.trim()}>
          {requestCode.isPending ? t('login.sending') : t('login.sendCode')}
          {!requestCode.isPending && <ArrowRightIcon />}
        </Button>
        <p className="text-center text-[13px] text-muted-foreground">{t('login.noPassword')}</p>
        <Button
          variant="link"
          size="sm"
          className="h-auto justify-self-center px-0"
          onClick={() => {
            requestCode.reset()
            setStep('key')
          }}
        >
          <KeyRoundIcon />
          {t('login.useKey')}
        </Button>
      </form>
    </AuthLayout>
  )
}
