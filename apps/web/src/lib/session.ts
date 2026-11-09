import { ApiError, type Me } from '@fudislte/api-client'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { isLanguage, type Language, setLanguage } from '../i18n'
import { api, queryKeys } from './api'

/** The signed-in user and their workspaces; `null` when signed out. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async (): Promise<Me | null> => {
      try {
        const me = await api.me()
        // The account's language wins over the device's, so it follows people everywhere.
        if (isLanguage(me.user.locale)) setLanguage(me.user.locale)
        return me
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null
        throw err
      }
    },
    staleTime: 60_000,
  })
}

/** Switches the UI language and, when signed in, saves it to the account. */
export function useChangeLanguage() {
  const queryClient = useQueryClient()
  return async (language: Language) => {
    setLanguage(language)
    const me = queryClient.getQueryData<Me | null>(queryKeys.me)
    if (me) {
      const { user } = await api.updateProfile({ locale: language })
      queryClient.setQueryData<Me | null>(queryKeys.me, (m) => (m ? { ...m, user } : m))
    }
    // Server-provided texts (permission names, messages) come back in the new language.
    await queryClient.invalidateQueries({ queryKey: queryKeys.permissions })
  }
}

export function useMeta() {
  return useQuery({ queryKey: queryKeys.meta, queryFn: api.meta, staleTime: 5 * 60_000 })
}

/** Accept only same-site relative paths as post-login destinations (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}
