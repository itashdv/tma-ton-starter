'use client'

import type { AdminAttachResponse, AdminPaymentDto, PaymentStatusDto } from '@tma/shared'
import { ORDER_ID_RE, isOrderId } from '@tma/shared'
import { useCallback, useState, type FormEvent } from 'react'

import { useLocale } from '@/app/me-context'
import { attachPayment, listPayments } from '@/lib/admin-api'
import { adminErrorMessage } from '@/lib/admin-errors'
import { t } from '@/lib/i18n'
import { useApi } from '@/lib/use-api'

import { PAYMENT_STATUSES } from './labels'
import { ListFooter } from './list-footer'
import { PaymentRow } from './payment-row'
import { StatusFilter } from './status-filter'
import { usePagedList } from './use-paged-list'

// The HTML pattern is the shared order-id rule without its anchors, so the two cannot drift.
const ORDER_ID_PATTERN = ORDER_ID_RE.source.replace(/^\^|\$$/g, '')

interface AttachFormProps {
  payment: AdminPaymentDto
  onAttached: (response: AdminAttachResponse) => void
}

/**
 * Manual matching for a payment the scanner could not attach (no comment, a typo, an
 * underpayment). Only an underpayment may be forced through; a currency mismatch never can.
 */
function AttachForm({ payment, onAttached }: AttachFormProps) {
  const api = useApi()
  const locale = useLocale()
  const [orderId, setOrderId] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const underpaid = payment.status === 'underpaid'

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Order ids are lower-case by construction; a pasted upper-case copy is still the same id.
    const value = orderId.trim().toLowerCase()
    if (!isOrderId(value)) {
      setMessage(t(locale, 'admin.attach.orderIdInvalid'))
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      onAttached(await attachPayment(api, payment.id, { orderId: value, force }))
    } catch (error) {
      setMessage(adminErrorMessage(error, locale, 'admin.attach.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      className="flex flex-col gap-2 border-t pt-3"
    >
      <div className="flex gap-2">
        <input
          aria-label={t(locale, 'admin.orderId')}
          placeholder={t(locale, 'admin.orderId')}
          value={orderId}
          onChange={(event) => setOrderId(event.target.value)}
          pattern={ORDER_ID_PATTERN}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? t(locale, 'admin.working') : t(locale, 'admin.attach.submit')}
        </button>
      </div>
      {underpaid ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
          />
          {t(locale, 'admin.attach.force')}
        </label>
      ) : null}
      {message ? (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
    </form>
  )
}

export function PaymentsTable() {
  const api = useApi()
  const locale = useLocale()
  const [status, setStatus] = useState<PaymentStatusDto | ''>('')
  const fetchPage = useCallback(
    (cursor: string | null) =>
      listPayments(api, { status, cursor }).then((page) => ({
        items: page.payments,
        nextCursor: page.nextCursor,
      })),
    [api, status],
  )
  const list = usePagedList(fetchPage)
  const { update } = list
  const attached = useCallback(
    (response: AdminAttachResponse) =>
      update((row) => (row.id === response.payment.id ? response.payment : row)),
    [update],
  )

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-medium">{t(locale, 'admin.tab.payments')}</h2>
        <StatusFilter
          value={status}
          options={PAYMENT_STATUSES}
          labelKey={(option) => `admin.paymentStatus.${option}`}
          onChange={setStatus}
        />
      </div>
      <ul className="flex flex-col gap-2">
        {(list.items ?? []).map((payment) => (
          <li key={payment.id}>
            <PaymentRow payment={payment}>
              {payment.status === 'unmatched' || payment.status === 'underpaid' ? (
                <AttachForm payment={payment} onAttached={attached} />
              ) : null}
            </PaymentRow>
          </li>
        ))}
      </ul>
      <ListFooter list={list} />
    </section>
  )
}
