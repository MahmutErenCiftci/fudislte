import { Alert, Button, Field, Input } from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightIcon, MailIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { useMe } from '../../lib/session'
import { AuthLayout, FullScreenMessage } from '../auth/AuthLayout'
import { CodeInput, isCompleteCode, ResendCode } from '../auth/CodeInput'

export function AcceptInvitationPage() {
  const t = useT()
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const preview = useQuery({ queryKey: queryKeys.invitation(token), queryFn: () => api.previewInvitation(token), retry: false })
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')

  const sendCode = useMutation({ mutationFn: () => api.invitationCode(token) })
  const accept = useMutation({
    mutationFn: () => api.acceptInvitation(token, me.data ? {} : { displayName, code }),
    onSuccess: async (organization) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      navigate(`/w/${organization.slug}`, { replace: true })
    },
  })
  const signOut = useMutation({
    mutationFn: api.logout,
    onSuccess: () => queryClient.setQueryData(queryKeys.me, null),
  })

  if (preview.isPending || me.isPending) return <FullScreenMessage>{t('common.loading')}</FullScreenMessage>
  if (preview.error) {
    return (
      <AuthLayout title={t('invite.unavailable')}>
        <div className="grid gap-4">
          <Alert variant="error">{errorMessage(preview.error)}</Alert>
          <p className="text-[13px] text-muted-foreground">{t('invite.askNew')}</p>
          <Button variant="outline" asChild>
            <Link to="/">{t('invite.goHome')}</Link>
          </Button>
        </div>
      </AuthLayout>
    )
  }

  const inv = preview.data
  const title = t('invite.title', { organization: inv.organizationName })
  const description = t('invite.description', { email: inv.email, role: inv.roleName })

  if (me.data) {
    if (me.data.user.email !== inv.email) {
      return (
        <AuthLayout title={title} description={description}>
          <div className="grid gap-4">
            <Alert variant="error">{t('invite.wrongAccount', { current: me.data.user.email, email: inv.email })}</Alert>
            <Button variant="outline" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
              {t('shell.signOut')}
            </Button>
          </div>
        </AuthLayout>
      )
    }
    return (
      <AuthLayout title={title} description={description}>
        <div className="grid gap-4">
          {accept.error && <Alert variant="error">{errorMessage(accept.error)}</Alert>}
          <Button size="lg" className="h-11" onClick={() => accept.mutate()} disabled={accept.isPending}>
            {accept.isPending ? t('invite.joining') : t('invite.join', { organization: inv.organizationName })}
          </Button>
        </div>
      </AuthLayout>
    )
  }

  if (inv.accountExists) {
    return (
      <AuthLayout title={title} description={description}>
        <div className="grid gap-4">
          <p className="text-[13px] text-muted-foreground">{t('invite.existingAccount')}</p>
          <Button size="lg" className="h-11" asChild>
            <Link to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>{t('invite.signInToContinue')}</Link>
          </Button>
        </div>
      </AuthLayout>
    )
  }

  const errors = fieldErrors(accept.error)
  const codeSent = sendCode.isSuccess
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (codeSent) accept.mutate()
    else sendCode.mutate()
  }
  const error = formError(accept.error) ?? (sendCode.error ? errorMessage(sendCode.error) : undefined)
  return (
    <AuthLayout title={title} description={description}>
      <form className="grid gap-5" onSubmit={submit} noValidate>
        {error && <Alert variant="error">{error}</Alert>}
        <Field label={t('login.email')}>
          <Input icon={<MailIcon />} className="h-11" value={inv.email} readOnly disabled />
        </Field>
        <Field label={t('login.yourName')} error={errors.displayName}>
          <Input className="h-11" autoComplete="name" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        {codeSent ? (
          <>
            <Field label={t('invite.codeFromEmail')} hint={t('invite.codeHint', { email: inv.email })}>
              <CodeInput autoFocus value={code} onChange={setCode} />
            </Field>
            <Button type="submit" size="lg" className="h-11" disabled={accept.isPending || !isCompleteCode(code) || !displayName.trim()}>
              {accept.isPending ? t('invite.joining') : t('invite.join', { organization: inv.organizationName })}
            </Button>
            <div className="flex justify-end">
              <ResendCode onResend={() => sendCode.mutate()} disabled={sendCode.isPending} />
            </div>
          </>
        ) : (
          <Button type="submit" size="lg" className="h-11" disabled={sendCode.isPending || !displayName.trim()}>
            {t('invite.emailMeCode')}
            <ArrowRightIcon />
          </Button>
        )}
        <p className="text-center text-xs text-muted-foreground">{t('invite.noPassword')}</p>
      </form>
    </AuthLayout>
  )
}
