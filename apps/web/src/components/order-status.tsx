'use client'

import type { OrderDto } from '@tma/shared'
import { useEffect, useState } from 'react'

import { useLocale } from '@/app/me-context'
import { errorMessage, isSessionExpired } from '@/lib/errors'
import { formatAmount } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useApi } from '@/lib/use-api'

export const ORDER_POLL_MS = 4000

/** Polls while the order is open; the chain, not this page, decides when it is paid. */
export function OrderStatus({ orderId }: { orderId: string }) {
  const api = useApi()
  const locale = useLocale()
  const [order, setOrder] = useState<OrderDto | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      timer = setTimeout(() => {
        // A hidden tab keeps the order open without burning requests.
        if (document.hidden) schedule()
        else void poll()
      }, ORDER_POLL_MS)
    }

    const poll = async () => {
      try {
        const data = await api.get<{ order: OrderDto }>(`/orders/${orderId}`)
        if (!active) return
        setOrder(data.order)
        setError(null)
        if (data.order.status === 'pending') schedule()
      } catch (failure) {
        if (!active) return
        setError(errorMessage(failure, locale, { fallbackKey: 'order.failed' }))
        // A dropped connection must not freeze the page forever: keep polling unless the
        // session itself expired, which only reopening the Mini App can fix.
        if (!isSessionExpired(failure)) schedule()
      }
    }

    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [api, locale, orderId])

  if (!order) {
    return (
      <p className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
        {error ?? t(locale, 'order.loading')}
      </p>
    )
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-medium">{order.productTitle}</h2>
        <p className="text-sm text-muted-foreground">
          {formatAmount(order.currency, order.amount)}
        </p>
      </header>
      <p data-testid="order-status" className="text-sm">
        {t(locale, `order.${order.status}`)}
      </p>
      {order.delivery?.payload ? (
        <p className="rounded-lg bg-secondary p-3 text-sm break-all" data-testid="order-delivery">
          {order.delivery.payload}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{order.id}</p>
    </section>
  )
}
