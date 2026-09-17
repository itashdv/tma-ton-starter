'use client'

import type { OrderStatusDto } from '@tma/shared'
import Link from 'next/link'
import { useCallback, useState } from 'react'

import { useLocale } from '@/app/me-context'
import { listOrders } from '@/lib/admin-api'
import { formatAmount, formatDateTime } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useApi } from '@/lib/use-api'

import { Badge } from './badge'
import { ORDER_STATUSES, orderStatusTone, orderUserLabel } from './labels'
import { ListFooter } from './list-footer'
import { StatusFilter } from './status-filter'
import { usePagedList } from './use-paged-list'

export function OrdersTable() {
  const api = useApi()
  const locale = useLocale()
  const [status, setStatus] = useState<OrderStatusDto | ''>('')
  const fetchPage = useCallback(
    (cursor: string | null) =>
      listOrders(api, { status, cursor }).then((page) => ({
        items: page.orders,
        nextCursor: page.nextCursor,
      })),
    [api, status],
  )
  const list = usePagedList(fetchPage)

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-medium">{t(locale, 'admin.tab.orders')}</h2>
        <StatusFilter
          value={status}
          options={ORDER_STATUSES}
          labelKey={(option) => `admin.orderStatus.${option}`}
          onChange={setStatus}
        />
      </div>
      <ul className="flex flex-col gap-2">
        {(list.items ?? []).map((order) => (
          <li key={order.id}>
            <Link
              href={`/admin/orders/${order.id}`}
              className="flex flex-col gap-1 rounded-xl border p-4"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{order.productTitle}</span>
                <Badge tone={orderStatusTone(order.status)}>
                  {t(locale, `admin.orderStatus.${order.status}`)}
                </Badge>
              </span>
              <span className="text-sm">
                {formatAmount(order.currency, order.amount)}
                {order.paidLate ? ` · ${t(locale, 'admin.order.paidLate')}` : ''}
              </span>
              <span className="text-xs text-muted-foreground">
                {orderUserLabel(order)} · {formatDateTime(order.createdAt, locale)}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{order.id}</span>
            </Link>
          </li>
        ))}
      </ul>
      <ListFooter list={list} />
    </section>
  )
}
