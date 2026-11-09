import '@fontsource-variable/inter'
import './index.css'

import { TooltipProvider, UiStringsProvider } from '@fudislte/ui'
import { QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'

import { router } from './app/routes'
import { useT } from './i18n'
import { queryClient } from './lib/api'

/** Gives the shared UI components their few built-in words in the current language. */
function TranslatedUi({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <UiStringsProvider value={{ close: t('common.close'), loading: t('common.loading'), online: t('people.online') }}>
      {children}
    </UiStringsProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TranslatedUi>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </TranslatedUi>
    </QueryClientProvider>
  </StrictMode>,
)
