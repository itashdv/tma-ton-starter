import type {
  AdminOrderDto,
  AdminPaymentDto,
  NotificationStatusDto,
  OrderStatusDto,
  PaymentStatusDto,
} from '@tma/shared'

import { formatAmount } from '@/lib/format'

import type { BadgeTone } from './badge'

export const ORDER_STATUSES: readonly OrderStatusDto[] = ['pending', 'paid', 'expired', 'cancelled']
export const PAYMENT_STATUSES: readonly PaymentStatusDto[] = [
  'matched',
  'underpaid',
  'unmatched',
  'ignored',
]

const ORDER_TONES: Record<OrderStatusDto, BadgeTone> = {
  pending: 'warn',
  paid: 'ok',
  expired: 'neutral',
  cancelled: 'neutral',
}

const PAYMENT_TONES: Record<PaymentStatusDto, BadgeTone> = {
  matched: 'ok',
  underpaid: 'warn',
  unmatched: 'warn',
  ignored: 'neutral',
}

const NOTIFICATION_TONES: Record<NotificationStatusDto, BadgeTone> = {
  pending: 'warn',
  sent: 'ok',
  failed: 'danger',
}

export function orderStatusTone(status: OrderStatusDto): BadgeTone {
  return ORDER_TONES[status]
}

export function paymentStatusTone(status: PaymentStatusDto): BadgeTone {
  return PAYMENT_TONES[status]
}

export function notificationStatusTone(status: NotificationStatusDto): BadgeTone {
  return NOTIFICATION_TONES[status]
}

/** "Name @username", falling back to the Telegram id when the profile has neither. */
export function orderUserLabel(
  order: Pick<AdminOrderDto, 'userFirstName' | 'userUsername' | 'userId'>,
): string {
  const parts = [order.userFirstName ?? '', order.userUsername ? `@${order.userUsername}` : '']
  return parts.filter((part) => part !== '').join(' ') || order.userId
}

/** A payment in an unknown currency (a foreign jetton) is shown in raw units. */
export function paymentAmountLabel(payment: Pick<AdminPaymentDto, 'currency' | 'amount'>): string {
  return payment.currency ? formatAmount(payment.currency, payment.amount) : payment.amount
}
