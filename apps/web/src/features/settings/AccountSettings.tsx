import { Alert, Avatar, Badge, Button, Field, Input, NativeSelect, Spinner } from '@fudislte/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LanguagesIcon, MonitorSmartphoneIcon, UserIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { isLanguage, languages, useLanguage, useT } from '../../i18n'
import { api, errorMessage, fieldErrors, formError, queryKeys } from '../../lib/api'
import { describeUserAgent, formatDateTime, formatRelative } from '../../lib/format'
import { useChangeLanguage } from '../../lib/session'
import { setTheme, type Theme, useTheme } from '../../lib/theme'
import { useWorkspace } from '../../shell/context'
import {
  type DesktopPreference,
  desktopSupported,
  setDesktopPreference,
  useDesktopPreference,
} from '../notifications/desktop'
import { SettingsCard } from './SettingsLayout'

export function AccountSettings() {
  return (
    <div className="grid max-w-3xl gap-6">
      <Profile />
      <Preferences />
      <Sessions />
    </div>
  )
}

function Profile() {
  const t = useT()
  const { me, workspace } = useWorkspace()
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(me.user.displayName)
  const save = useMutation({
    mutationFn: () => api.updateProfile({ displayName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      await queryClient.invalidateQueries({ queryKey: queryKeys.members(workspace.organization.id) })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  return (
    <SettingsCard icon={UserIcon} title={t('account.profile')} description={t('account.profileDescription')}>
      <form className="grid gap-4" onSubmit={submit}>
        {formError(save.error) && <Alert variant="error">{formError(save.error)}</Alert>}
        <div className="flex items-center gap-4">
          <Avatar name={displayName || me.user.displayName} seed={me.user.id} size="xl" />
          <div className="grid flex-1 gap-4 sm:grid-cols-2">
            <Field label={t('account.displayName')} error={fieldErrors(save.error).displayName}>
              <Input autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label={t('account.email')} hint={t('account.emailHint')}>
              <Input value={me.user.email} readOnly disabled />
            </Field>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3">
          {save.isSuccess && <span className="text-[13px] text-muted-foreground">{t('common.saved')}</span>}
          <Button type="submit" disabled={save.isPending || displayName.trim() === me.user.displayName}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </SettingsCard>
  )
}

function Preferences() {
  const t = useT()
  const language = useLanguage()
  const theme = useTheme()
  const changeLanguage = useChangeLanguage()
  const [error, setError] = useState<unknown>(null)
  return (
    <SettingsCard icon={LanguagesIcon} title={t('account.preferences')} description={t('account.preferencesDescription')}>
      {error !== null && <Alert variant="error" className="mb-4">{errorMessage(error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('language.label')}>
          <NativeSelect
            value={language}
            onChange={(e) => {
              if (!isLanguage(e.target.value)) return
              setError(null)
              changeLanguage(e.target.value).catch(setError)
            }}
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('theme.label')}>
          <NativeSelect value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="light">{t('theme.light')}</option>
            <option value="dark">{t('theme.dark')}</option>
            <option value="system">{t('theme.system')}</option>
          </NativeSelect>
        </Field>
        <DesktopNotifications />
      </div>
    </SettingsCard>
  )
}

/** Per-device choice of desktop notifications, and the browser permission they need. */
function DesktopNotifications() {
  const t = useT()
  const preference = useDesktopPreference()
  const [permission, setPermission] = useState(() => (desktopSupported() ? Notification.permission : 'denied'))
  if (!desktopSupported()) return null
  return (
    <div className="flex flex-wrap items-start gap-3 sm:col-span-2">
      <Field
        label={t('notify.desktop')}
        hint={permission === 'denied' ? t('notify.desktopBlocked') : t('notify.desktopHint')}
        className="min-w-64 flex-1"
      >
        <NativeSelect value={preference} onChange={(e) => setDesktopPreference(e.target.value as DesktopPreference)}>
          <option value="all">{t('notify.prefAll')}</option>
          <option value="mentions">{t('notify.prefMentions')}</option>
          <option value="off">{t('notify.prefOff')}</option>
        </NativeSelect>
      </Field>
      {permission === 'default' && preference !== 'off' && (
        <Button variant="outline" className="mt-[21px]" onClick={() => void Notification.requestPermission().then(setPermission)}>
          {t('notify.desktopEnable')}
        </Button>
      )}
    </div>
  )
}

function Sessions() {
  const t = useT()
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions })
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
  const revoke = useMutation({ mutationFn: api.revokeSession, onSuccess: refresh })
  const revokeOthers = useMutation({ mutationFn: api.revokeOtherSessions, onSuccess: refresh })
  const others = sessions.data?.filter((s) => !s.current).length ?? 0
  const error = revoke.error ?? revokeOthers.error ?? sessions.error

  return (
    <SettingsCard
      icon={MonitorSmartphoneIcon}
      title={t('account.sessions')}
      description={t('account.sessionsDescription')}
      actions={
        others > 0 && (
          <Button variant="outline" size="sm" onClick={() => revokeOthers.mutate()} disabled={revokeOthers.isPending}>
            {t('account.signOutOthers')}
          </Button>
        )
      }
    >
      {error && <Alert variant="error">{errorMessage(error)}</Alert>}
      {sessions.isPending && <Spinner />}
      {sessions.data && (
        <ul className="divide-y rounded-lg border">
          {sessions.data.map((s) => (
            <li key={s.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[14px] font-medium">
                  {describeUserAgent(s.userAgent)}
                  {s.current && <Badge variant="primary">{t('account.thisDevice')}</Badge>}
                </p>
                <p className="text-[13px] text-muted-foreground" title={t('account.signedIn', { time: formatDateTime(s.createdAt) })}>
                  {s.ipAddress || t('account.unknownAddress')} · {t('account.active', { time: formatRelative(s.lastSeenAt) })}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                  {t('account.signOut')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}
