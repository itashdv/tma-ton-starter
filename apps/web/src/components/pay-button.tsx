'use client'

import type { CreateOrderResponse, OrderCurrency, ProductDto } from '@tma/shared'
import { useIsConnectionRestored, useTonConnectUI, useTonWallet } from '@tonconnect/ui-react'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'

import { useLocale, useMe } from '@/app/me-context'
import { errorMessage } from '@/lib/errors'
import { formatAmount } from '@/lib/format'
import { t } from '@/lib/i18n'
import { payWithWallet } from '@/lib/pay'
import { buildSendTransactionRequest } from '@/lib/tonconnect'
import { useApi } from '@/lib/use-api'

export type PayState = 'idle' | 'creating' | 'signing' | 'declined' | 'wrong_network' | 'failed'

export interface PayButtonProps {
  product: ProductDto
  currency: OrderCurrency
  amount: string
}

/**
 * The button never computes an amount or an address: it asks the API for an order and passes
 * the returned messages to the wallet unchanged.
 */
export function PayButton({ product, currency, amount }: PayButtonProps) {
  const [tonConnectUI] = useTonConnectUI()
  const wallet = useTonWallet()
  const connectionRestored = useIsConnectionRestored()
  const api = useApi()
  const router = useRouter()
  const locale = useLocale()
  const { me } = useMe()
  const [state, setState] = useState<PayState>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const onClick = useCallback(async () => {
    if (!tonConnectUI) return
    if (!wallet) {
      await tonConnectUI.openModal()
      return
    }
    // Checking the network here avoids creating an order the wallet is going to refuse.
    if (me && wallet.account.chain !== me.tonNetworkId) {
      setState('wrong_network')
      setMessage(t(locale, 'checkout.wrongNetwork'))
      return
    }

    setState('creating')
    setMessage(null)
    try {
      const { order, payment } = await api.post<CreateOrderResponse>('/orders', {
        productId: product.id,
        currency,
        walletAddress: wallet.account.address,
      })
      setState('signing')
      const request = buildSendTransactionRequest({
        payment,
        walletAddress: wallet.account.address,
      })
      const outcome = await payWithWallet(tonConnectUI, request)
      if (outcome.kind === 'sent') {
        // Progress information for the order page; the chain decides whether it is paid.
        await api.post(`/orders/${order.id}/submitted`, { boc: outcome.boc }).catch(() => undefined)
        router.push(`/orders/${order.id}`)
        return
      }
      if (outcome.kind === 'declined') {
        setState('declined')
        setMessage(t(locale, 'checkout.declined'))
      } else if (outcome.kind === 'wrong_network') {
        setState('wrong_network')
        setMessage(t(locale, 'checkout.wrongNetwork'))
      } else if (outcome.kind === 'not_connected') {
        setState('idle')
      } else {
        setState('failed')
        setMessage(t(locale, 'checkout.failed'))
      }
    } catch (error) {
      setState('failed')
      setMessage(errorMessage(error, locale, { fallbackKey: 'checkout.failed' }))
    }
  }, [api, currency, locale, me, product.id, router, tonConnectUI, wallet])

  const busy = state === 'creating' || state === 'signing' || !connectionRestored
  const label = wallet
    ? `${t(locale, 'checkout.pay')} · ${formatAmount(currency, amount)}`
    : t(locale, 'checkout.connect')

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void onClick()}
        // Until the stored connection is restored the wallet looks absent, and the button
        // would offer to connect a wallet that is already connected.
        disabled={busy}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {busy ? `${t(locale, 'checkout.pay')}…` : label}
      </button>
      {message ? (
        <p
          className={
            state === 'declined' ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'
          }
          role={state === 'declined' ? 'status' : 'alert'}
        >
          {message}
        </p>
      ) : null}
    </div>
  )
}
