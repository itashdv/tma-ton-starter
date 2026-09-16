'use client'

import type { OrderDto } from '@tma/shared'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { useLocale } from '@/app/me-context'
import { formatAmount, formatDateTime } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useApi } from '@/lib/use-api'

export default function OrdersPage() {
  const api = useApi()
  const locale = useLocale()
  const [orders, setOrders] = useState<OrderDto[] | null>(null)

  useEffect(() => {
    let active = true
    api
      .get<{ orders: OrderDto[] }>('/orders')
      .then((data) => {
        if (active) setOrders(data.orders)
      })
      .catch(() => {
        if (active) setOrders([])
      })
    return () => {
      active = false
    }
  }, [api])

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">{t(locale, 'orders.title')}</h1>
        <Link href="/" className="text-sm text-primary underline">
          {t(locale, 'catalog.title')}
        </Link>
      </div>
      {orders === null ? (
        <p className="text-sm text-muted-foreground">{t(locale, 'order.loading')}</p>
      ) : null}
      {orders?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, 'orders.empty')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {(orders ?? []).map((order) => (
          <li key={order.id}>
            <Link
              href={`/orders/${order.id}`}
              className="flex flex-col gap-1 rounded-lg border p-3"
            >
              <span className="font-medium">{order.productTitle}</span>
              <span className="text-sm text-muted-foreground">
                {formatAmount(order.currency, order.amount)} · {t(locale, `order.${order.status}`)}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(order.createdAt, locale)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
