'use client'

import type { MeResponse } from '@tma/shared'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

import { pickLocale } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'
import { useApi } from '@/lib/use-api'

/**
 * One `GET /me` per launch, shared by everything that needs the profile: the interface
 * language, whether the bot may message the user, and which network the shop expects.
 */

export interface MeState {
  me: MeResponse | null
  failed: boolean
  refresh: () => void
}

const MeContext = createContext<MeState>({ me: null, failed: false, refresh: () => {} })

export function MeProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const [me, setMe] = useState<MeResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    api
      .get<MeResponse>('/me')
      .then((data) => {
        if (!active) return
        setMe(data)
        setFailed(false)
      })
      .catch(() => {
        // The catalogue must stay usable even when the profile call fails.
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [api, nonce])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  return <MeContext value={{ me, failed, refresh }}>{children}</MeContext>
}

export function useMe(): MeState {
  return useContext(MeContext)
}

/** Telegram's language when the shop speaks it, the configured default otherwise. */
export function useLocale(): string {
  const { me } = useMe()
  return pickLocale(me?.user.languageCode ?? shopConfig.defaultLocale)
}
