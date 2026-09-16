'use client'

import { TonConnectUIProvider } from '@tonconnect/ui-react'
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'

import { ErrorBoundary } from '@/components/error-boundary'
import { StartParamRouter } from '@/components/start-param-router'
import { t } from '@/lib/i18n'
import { publicEnv } from '@/lib/env'
import { shopConfig } from '@/lib/shop-config'
import { initTelegram, isInsideTelegram, readRawInitData } from '@/lib/telegram'

import { InitDataContext } from './init-data-context'
import { MeProvider } from './me-context'

/**
 * Nothing Telegram- or wallet-related may run on the server: the SDKs read window.location and
 * localStorage. The tree below therefore renders only after mount, and the raw init data is
 * read once and shared through context so every request uses the same string.
 */
const subscribeToNothing = () => () => {}

export function Providers({ children }: { children: ReactNode }) {
  // Hydration gate without state: false on the server, true once mounted in the browser.
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  )

  useEffect(() => {
    if (!mounted || !isInsideTelegram()) return
    return initTelegram()
  }, [mounted])

  const launch = useMemo(() => (mounted ? readRawInitData() : null), [mounted])
  const initDataRaw = launch?.raw
  const outsideTelegram = launch !== null && (launch.outsideTelegram || launch.raw === undefined)

  if (!mounted) {
    return <div className="p-6 text-sm text-muted-foreground">…</div>
  }

  const openFromTelegram = (
    <main className="mx-auto flex max-w-md flex-col gap-3 px-4 py-10">
      <h1 className="text-xl font-semibold">{shopConfig.name}</h1>
      <p className="text-muted-foreground">{t(shopConfig.defaultLocale, 'error.openInTelegram')}</p>
    </main>
  )

  if (outsideTelegram) return openFromTelegram

  return (
    <ErrorBoundary fallback={openFromTelegram}>
      <TonConnectUIProvider
        manifestUrl={`${publicEnv.appUrl}/tonconnect-manifest.json`}
        restoreConnection
        // Telegram wallets return to the Mini App through this link after signing.
        actionsConfiguration={{
          returnStrategy: 'back',
          ...(publicEnv.twaReturnUrl
            ? { twaReturnUrl: publicEnv.twaReturnUrl as `${string}://${string}` }
            : {}),
        }}
        walletsRequiredFeatures={{ sendTransaction: { minMessages: 1 } }}
        // Keeps the storefront free of third-party telemetry (and out of the CSP).
        analytics={{ mode: 'off' }}
      >
        <InitDataContext value={initDataRaw}>
          <MeProvider>
            <StartParamRouter />
            {children}
          </MeProvider>
        </InitDataContext>
      </TonConnectUIProvider>
    </ErrorBoundary>
  )
}
