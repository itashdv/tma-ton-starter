import { notifications, orders, payments, users, type Db } from '@tma/db'

import { authHeader, seedProduct } from '../helpers/auth'
import { buildTestApp, testEnv, type TestApp } from '../helpers/build-app'
import { rawAddress } from '../helpers/tx-factory'

/** Shared fixtures for the admin API tests: one admin, one ordinary user, direct row inserts. */

export const ADMIN_ID = 7
export const USER_ID = 42
export const NOW = new Date('2026-09-16T12:00:00Z')
export const NOW_SEC = Math.floor(NOW.getTime() / 1000)
export const MERCHANT = rawAddress('aa')
export const JETTON_WALLET = rawAddress('bb')
export const MASTER = rawAddress('cc')
export const PAYER = rawAddress('11')

export function adminApp(overrides: { adminIds?: string; now?: Date } = {}): TestApp {
  return buildTestApp({
    now: () => overrides.now ?? NOW,
    env: testEnv({ TELEGRAM_ADMIN_IDS: overrides.adminIds ?? String(ADMIN_ID) }),
  })
}

export function asAdmin(): Record<string, string> {
  return { authorization: authHeader({ id: ADMIN_ID, authDate: NOW_SEC }) }
}

export function asUser(): Record<string, string> {
  return { authorization: authHeader({ id: USER_ID, authDate: NOW_SEC }) }
}

export async function seedUser(db: Db, id: number = USER_ID): Promise<void> {
  await db
    .insert(users)
    .values({ telegramId: BigInt(id), firstName: 'Test', username: 'tester', languageCode: 'en' })
    .onConflictDoNothing()
}

export interface SeedOrderOptions {
  id: string
  productId: string
  userId?: number
  status?: 'pending' | 'paid' | 'expired' | 'cancelled'
  currency?: 'TON' | 'USDT'
  amount?: bigint
  createdAt?: Date
  expiresAt?: Date
  paidAt?: Date | null
  payerAddress?: string | null
}

export async function seedOrder(db: Db, options: SeedOrderOptions) {
  const currency = options.currency ?? 'TON'
  const createdAt = options.createdAt ?? NOW
  const [row] = await db
    .insert(orders)
    .values({
      id: options.id,
      userId: BigInt(options.userId ?? USER_ID),
      productId: options.productId,
      productTitle: 'Guide',
      currency,
      amount: options.amount ?? (currency === 'TON' ? 1_500_000_000n : 5_000_000n),
      jettonMaster: currency === 'USDT' ? MASTER : null,
      merchantAddress: MERCHANT,
      payerAddress: options.payerAddress === undefined ? PAYER : options.payerAddress,
      status: options.status ?? 'pending',
      paidAt: options.paidAt ?? null,
      expiresAt: options.expiresAt ?? new Date(createdAt.getTime() + 30 * 60_000),
      createdAt,
      updatedAt: createdAt,
    })
    .returning()
  if (!row) throw new Error('order not inserted')
  return row
}

let paymentSeq = 0

export interface SeedPaymentOptions {
  status?: 'matched' | 'underpaid' | 'unmatched' | 'ignored'
  currency?: 'TON' | 'USDT' | null
  amount?: bigint
  comment?: string | null
  orderId?: string | null
  senderAddress?: string | null
  sourceWallet?: string | null
  reason?: string | null
  createdAt?: Date
  txLt?: bigint
  account?: string
}

export async function seedPayment(db: Db, options: SeedPaymentOptions = {}) {
  paymentSeq += 1
  const currency = options.currency === undefined ? 'TON' : options.currency
  const [row] = await db
    .insert(payments)
    .values({
      account: options.account ?? (currency === 'USDT' ? JETTON_WALLET : MERCHANT),
      txHash: paymentSeq.toString(16).padStart(64, '0'),
      txLt: options.txLt ?? BigInt(1000 + paymentSeq),
      txNow: NOW,
      mcBlockSeqno: 1n,
      currency,
      jettonMaster: currency === 'USDT' ? MASTER : null,
      sourceWallet: options.sourceWallet ?? null,
      amount: options.amount ?? (currency === 'USDT' ? 5_000_000n : 1_500_000_000n),
      senderAddress: options.senderAddress === undefined ? PAYER : options.senderAddress,
      comment: options.comment === undefined ? null : options.comment,
      orderId: options.orderId ?? null,
      status: options.status ?? 'unmatched',
      reason: options.reason ?? null,
      raw: { seq: paymentSeq },
      createdAt: options.createdAt ?? NOW,
    })
    .returning()
  if (!row) throw new Error('payment not inserted')
  return row
}

export async function seedNotification(
  db: Db,
  orderId: string,
  options: {
    status?: 'pending' | 'sent' | 'failed'
    attempts?: number
    lastError?: string
    claimedAt?: Date | null
  } = {},
) {
  const [row] = await db
    .insert(notifications)
    .values({
      orderId,
      telegramUserId: BigInt(USER_ID),
      status: options.status ?? 'pending',
      attempts: options.attempts ?? 0,
      lastError: options.lastError ?? null,
      claimedAt: options.claimedAt ?? null,
      nextAttemptAt: NOW,
      createdAt: NOW,
    })
    .returning()
  if (!row) throw new Error('notification not inserted')
  return row
}

export { seedProduct }
