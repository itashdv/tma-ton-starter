'use client'

import type { AdminOrderDetailsDto } from '@tma/shared'
import { useCallback, useEffect, useState } from 'react'

import { useLocale } from '@/app/me-context'
import { cancelOrder, getOrder, resendNotification } from '@/lib/admin-api'
import { adminErrorMessage } from '@/lib/admin-errors'
import { formatAmount, formatDateTime } from '@/lib/format'
import { t } from '@/lib/i18n'
import { shorten } from '@/lib/shorten'
import { useApi } from '@/lib/use-api'

import { Badge } from './badge'
import { DetailRow } from './detail-row'
import { notificationStatusTone, orderStatusTone, orderUserLabel } from './labels'
import { PaymentRow } from './payment-row'

const BUTTON = 'rounded-lg border px-3 py-1.5 text-sm disabled:opacity-60'
const DASH = '—'

export function OrderDetails({ orderId }: { orderId: string }) {
  const api = useApi()
  const locale = useLocale()
  const [details, setDetails] = useState<AdminOrderDetailsDto | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    getOrder(api, orderId)
      .then((data) => {
        if (!active) return
        setDetails(data)
        setLoadError(null)
      })
      .catch((failure: unknown) => {
        if (active) setLoadError(failure)
      })
    return () => {
      active = false
    }
  }, [api, orderId, nonce])

  // Every action is followed by a reload: the API, not the click, says what the order is now.
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
      setNonce((value) => value + 1)
    } catch (failure) {
      setActionError(failure)
    } finally {
      setBusy(false)
    }
  }, [])

  if (!details) {
    return loadError ? (
      <p role="alert" className="text-sm text-destructive">
        {adminErrorMessage(loadError, locale, 'admin.loadFailed')}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">{t(locale, 'admin.loadingData')}</p>
    )
  }

  const { order, payments, notifications } = details
  const cancellable = order.status === 'pending' || order.status === 'expired'
  const paid = order.status === 'paid'

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-xl border p-4">
        <header className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">{order.productTitle}</h2>
            <p className="font-mono text-xs text-muted-foreground">{order.id}</p>
          </div>
          <Badge tone={orderStatusTone(order.status)}>
            {t(locale, `admin.orderStatus.${order.status}`)}
          </Badge>
        </header>
        <dl className="flex flex-col gap-1 text-sm">
          <DetailRow label={t(locale, 'admin.order.amount')}>
            {formatAmount(order.currency, order.amount)}
          </DetailRow>
          <DetailRow label={t(locale, 'admin.order.user')}>
            {orderUserLabel(order)}{' '}
            <span className="font-mono text-muted-foreground">{order.userId}</span>
          </DetailRow>
          <DetailRow label={t(locale, 'admin.order.payer')}>
            {order.payerAddress ? <span className="font-mono">{order.payerAddress}</span> : DASH}
          </DetailRow>
          <DetailRow label={t(locale, 'admin.order.merchant')}>
            <span className="font-mono">{shorten(order.merchantAddress, 6)}</span>
          </DetailRow>
          <DetailRow label={t(locale, 'admin.order.created')}>
            {formatDateTime(order.createdAt, locale)}
          </DetailRow>
          <DetailRow label={t(locale, 'admin.order.expires')}>
            {formatDateTime(order.expiresAt, locale)}
          </DetailRow>
          {order.submittedAt ? (
            <DetailRow label={t(locale, 'admin.order.submitted')}>
              {formatDateTime(order.submittedAt, locale)}
            </DetailRow>
          ) : null}
          {order.paidAt ? (
            <DetailRow label={t(locale, 'admin.order.paidAt')}>
              {formatDateTime(order.paidAt, locale)}
              {order.paidLate ? (
                <>
                  {' '}
                  <Badge tone="warn">{t(locale, 'admin.order.paidLate')}</Badge>
                </>
              ) : null}
            </DetailRow>
          ) : null}
          {order.extMsgHash ? (
            <DetailRow label={t(locale, 'admin.order.extMsgHash')}>
              <span className="font-mono">{shorten(order.extMsgHash, 6)}</span>
            </DetailRow>
          ) : null}
          {order.cancelledAt ? (
            <DetailRow label={t(locale, 'admin.order.cancelledAt')}>
              {formatDateTime(order.cancelledAt, locale)}
            </DetailRow>
          ) : null}
          {order.cancelledBy ? (
            <DetailRow label={t(locale, 'admin.order.cancelledBy')}>{order.cancelledBy}</DetailRow>
          ) : null}
          {order.adminNote ? (
            <DetailRow label={t(locale, 'admin.order.note')}>{order.adminNote}</DetailRow>
          ) : null}
          {order.delivery ? (
            <DetailRow label={t(locale, 'admin.order.deliverInChat')}>
              {t(locale, order.delivery.deliverInChat ? 'admin.yes' : 'admin.no')}
            </DetailRow>
          ) : null}
        </dl>
        {order.delivery?.payload ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">{t(locale, 'admin.order.delivery')}</p>
            <p className="rounded-lg bg-secondary p-3 font-mono text-xs break-all">
              {order.delivery.payload}
            </p>
          </div>
        ) : null}
        {cancellable || paid ? (
          <div className="flex flex-col gap-2 border-t pt-3">
            {cancellable ? (
              <>
                <input
                  aria-label={t(locale, 'admin.order.cancelNote')}
                  placeholder={t(locale, 'admin.order.cancelNote')}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="rounded-lg border bg-background px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={busy}
                  className={`${BUTTON} text-destructive`}
                  onClick={() =>
                    void run(() => cancelOrder(api, order.id, note.trim() || undefined))
                  }
                >
                  {busy ? t(locale, 'admin.working') : t(locale, 'admin.order.cancel')}
                </button>
              </>
            ) : null}
            {paid ? (
              <button
                type="button"
                disabled={busy}
                className={BUTTON}
                onClick={() => void run(() => resendNotification(api, order.id))}
              >
                {busy ? t(locale, 'admin.working') : t(locale, 'admin.order.resend')}
              </button>
            ) : null}
            {actionError !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {adminErrorMessage(actionError, locale, 'admin.order.actionFailed')}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">{t(locale, 'admin.order.payments')}</h3>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, 'admin.empty')}</p>
        ) : null}
        {payments.map((payment) => (
          <PaymentRow key={payment.id} payment={payment} />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">{t(locale, 'admin.order.notifications')}</h3>
        {notifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, 'admin.empty')}</p>
        ) : null}
        {notifications.map((notification) => (
          <article key={notification.id} className="flex flex-col gap-1 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{notification.kind}</span>
              <Badge tone={notificationStatusTone(notification.status)}>
                {t(locale, `admin.notificationStatus.${notification.status}`)}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(locale, 'admin.notification.attempts', { count: notification.attempts })}
              {notification.sentAt
                ? ` · ${t(locale, 'admin.notification.sentAt')} ${formatDateTime(notification.sentAt, locale)}`
                : ` · ${t(locale, 'admin.notification.nextAttempt')} ${formatDateTime(notification.nextAttemptAt, locale)}`}
            </p>
            {notification.lastError ? (
              <p className="text-xs text-destructive break-all">{notification.lastError}</p>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  )
}
