'use client'

import type { AdminPaymentDto } from '@tma/shared'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { useLocale } from '@/app/me-context'
import { formatDateTime } from '@/lib/format'
import { t } from '@/lib/i18n'
import { shorten } from '@/lib/shorten'
import { Badge } from './badge'
import { DetailRow } from './detail-row'
import { paymentAmountLabel, paymentStatusTone } from './labels'

const LINK = 'font-mono text-primary underline'
const DASH = '—'

/** One on-chain payment as a card; `children` holds row actions such as the attach form. */
export function PaymentRow({
  payment,
  children,
}: {
  payment: AdminPaymentDto
  children?: ReactNode
}) {
  const locale = useLocale()

  let sender: ReactNode = DASH
  if (payment.senderAddress !== null) {
    const short = shorten(payment.senderAddress)
    sender = payment.senderUrl ? (
      <a href={payment.senderUrl} target="_blank" rel="noreferrer" className={LINK}>
        {short}
      </a>
    ) : (
      <span className="font-mono">{short}</span>
    )
  }

  return (
    <article className="flex flex-col gap-2 rounded-xl border p-4">
      <header className="flex items-center justify-between gap-2">
        <span className="font-medium">{paymentAmountLabel(payment)}</span>
        <Badge tone={paymentStatusTone(payment.status)}>
          {t(locale, `admin.paymentStatus.${payment.status}`)}
        </Badge>
      </header>
      <dl className="flex flex-col gap-1 text-xs">
        <DetailRow label={t(locale, 'admin.payment.tx')}>
          <a href={payment.tonviewerUrl} target="_blank" rel="noreferrer" className={LINK}>
            {shorten(payment.txHash)}
          </a>
        </DetailRow>
        <DetailRow label={t(locale, 'admin.payment.sender')}>{sender}</DetailRow>
        {payment.comment ? (
          <DetailRow label={t(locale, 'admin.payment.comment')}>{payment.comment}</DetailRow>
        ) : null}
        {payment.orderId ? (
          <DetailRow label={t(locale, 'admin.payment.order')}>
            <Link href={`/admin/orders/${payment.orderId}`} className={LINK}>
              {payment.orderId}
            </Link>
          </DetailRow>
        ) : null}
        {payment.status === 'ignored' ? (
          <>
            <DetailRow label={t(locale, 'admin.payment.reason')}>
              {payment.reason ?? DASH}
            </DetailRow>
            <DetailRow label={t(locale, 'admin.payment.sourceWallet')}>
              {payment.sourceWallet ? (
                <span className="font-mono">{payment.sourceWallet}</span>
              ) : (
                DASH
              )}
            </DetailRow>
          </>
        ) : null}
        {payment.attachedBy ? (
          <DetailRow label={t(locale, 'admin.payment.attachedBy')}>{payment.attachedBy}</DetailRow>
        ) : null}
        <DetailRow label={t(locale, 'admin.order.created')}>
          {formatDateTime(payment.createdAt, locale)}
        </DetailRow>
      </dl>
      {payment.payerMismatch ? (
        <p className="text-xs text-destructive">{t(locale, 'admin.payment.payerMismatch')}</p>
      ) : null}
      {children}
    </article>
  )
}
