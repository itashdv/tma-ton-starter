import {
  PG_UNIQUE_VIOLATION,
  notifications,
  orders,
  payments,
  pgErrorCode,
  scanCursors,
  users,
  type Db,
  type DbHandle,
} from '@tma/db'
import { createTestDb, truncateAll } from '@tma/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyPayment, type PaymentEvent } from '../../src/services/payments'
import type { Candidate, Ignored } from '../../src/worker/classify'
import { seedProduct } from '../helpers/auth'
import { rawAddress } from '../helpers/tx-factory'

const MERCHANT = rawAddress('aa')
const JETTON_WALLET = rawAddress('bb')
const MASTER = rawAddress('cc')
const OTHER_MASTER = rawAddress('dd')
const PAYER = rawAddress('11')
const STRANGER = rawAddress('55')
const USER_ID = 279_058_397n
const ORDER_ID = '0123456789abcdef'
const OTHER_ORDER_ID = 'zzzzzzzzzzzzzzzz'

const now = new Date('2026-09-16T12:00:00Z')
const txNow = new Date('2026-09-16T11:59:30Z')

let handle: DbHandle
let db: Db

beforeAll(() => {
  handle = createTestDb()
  db = handle.db
})

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await truncateAll(db)
  await db.insert(users).values({ telegramId: USER_ID, firstName: 'Test', languageCode: 'ru' })
  await db.insert(scanCursors).values([
    { account: MERCHANT, label: 'ton_wallet', lastLt: 100n, lastHash: 'a'.repeat(64) },
    { account: JETTON_WALLET, label: 'usdt_jetton_wallet', lastLt: 100n, lastHash: 'b'.repeat(64) },
  ])
})

interface SeedOrderOptions {
  id?: string
  currency?: 'TON' | 'USDT'
  amount?: bigint
  status?: 'pending' | 'paid' | 'expired' | 'cancelled'
  payerAddress?: string | null
  expiresAt?: Date
  jettonMaster?: string | null
}

async function seedOrder(options: SeedOrderOptions = {}) {
  const product = await seedProduct(db, { slug: `p-${options.id ?? ORDER_ID}` })
  const currency = options.currency ?? 'TON'
  const [order] = await db
    .insert(orders)
    .values({
      id: options.id ?? ORDER_ID,
      userId: USER_ID,
      productId: product.id,
      productTitle: product.title,
      currency,
      amount: options.amount ?? (currency === 'TON' ? 1_500_000_000n : 5_000_000n),
      jettonMaster:
        options.jettonMaster === undefined
          ? currency === 'USDT'
            ? MASTER
            : null
          : options.jettonMaster,
      merchantAddress: MERCHANT,
      payerAddress: options.payerAddress === undefined ? PAYER : options.payerAddress,
      status: options.status ?? 'pending',
      expiresAt: options.expiresAt ?? new Date(now.getTime() + 30 * 60_000),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!order) throw new Error('order not inserted')
  return order
}

let seq = 0
function nextHash(): string {
  seq += 1
  return seq.toString(16).padStart(64, '0')
}

function tonCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    kind: 'candidate',
    currency: 'TON',
    jettonMaster: null,
    amount: 1_500_000_000n,
    sender: PAYER,
    comment: ORDER_ID,
    abortedNonBounceable: false,
    ...overrides,
  } as Candidate
}

function usdtCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    kind: 'candidate',
    currency: 'USDT',
    jettonMaster: MASTER,
    amount: 5_000_000n,
    sender: PAYER,
    comment: ORDER_ID,
    abortedNonBounceable: false,
    ...overrides,
  } as Candidate
}

function event(
  classification: Candidate | Ignored,
  overrides: Partial<PaymentEvent> = {},
): PaymentEvent {
  const usdt = classification.currency === 'USDT'
  return {
    account: usdt ? JETTON_WALLET : MERCHANT,
    txHash: nextHash(),
    txLt: 200n,
    txNow,
    mcBlockSeqno: 92_816_994n,
    traceId: null,
    classification,
    raw: { hash: 'raw' },
    ...overrides,
  }
}

async function snapshot() {
  return {
    payments: await db.select().from(payments),
    orders: await db.select().from(orders),
    notifications: await db.select().from(notifications),
    cursors: await db.select().from(scanCursors),
  }
}

describe('applyPayment: matching', () => {
  it('marks a pending order paid, records one matched row and queues one notification', async () => {
    const order = await seedOrder()
    const result = await applyPayment(db, event(tonCandidate()), { touchCursor: true, now })
    expect(result).toMatchObject({
      duplicate: false,
      status: 'matched',
      reason: null,
      orderId: order.id,
      notified: true,
    })

    const s = await snapshot()
    expect(s.payments).toHaveLength(1)
    expect(s.payments[0]).toMatchObject({
      status: 'matched',
      orderId: order.id,
      currency: 'TON',
      amount: 1_500_000_000n,
      senderAddress: PAYER,
      comment: ORDER_ID,
      payerMismatch: false,
      account: MERCHANT,
      txLt: 200n,
    })
    expect(s.orders[0]).toMatchObject({ status: 'paid', paidAt: txNow, paidLate: false })
    expect(s.notifications).toHaveLength(1)
    expect(s.notifications[0]).toMatchObject({
      orderId: order.id,
      kind: 'order_paid',
      telegramUserId: USER_ID,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
    })
  })

  it('reports a repeated transaction as duplicate without touching anything', async () => {
    await seedOrder()
    const ev = event(tonCandidate())
    await applyPayment(db, ev, { touchCursor: true, now })
    const before = await snapshot()

    const again = await applyPayment(
      db,
      { ...ev, raw: { different: true } },
      { touchCursor: true, now },
    )
    expect(again).toEqual({ duplicate: true })
    expect(await snapshot()).toEqual(before)
  })

  it('records an underpayment without paying the order or notifying', async () => {
    const order = await seedOrder({ amount: 1_500_000_000n })
    const result = await applyPayment(db, event(tonCandidate({ amount: 1_499_999_999n })), {
      touchCursor: true,
      now,
    })
    expect(result).toMatchObject({ status: 'underpaid', reason: null, orderId: order.id })
    const s = await snapshot()
    expect(s.payments[0]).toMatchObject({ status: 'underpaid', orderId: order.id })
    expect(s.orders[0]?.status).toBe('pending')
    expect(s.notifications).toHaveLength(0)
  })

  it('accepts an overpayment', async () => {
    await seedOrder({ amount: 1_500_000_000n })
    const result = await applyPayment(db, event(tonCandidate({ amount: 2_000_000_000n })), {
      touchCursor: true,
      now,
    })
    expect(result).toMatchObject({ status: 'matched' })
    expect((await snapshot()).orders[0]?.status).toBe('paid')
  })

  it('never credits a foreign asset: USDT for a TON order, even when the numbers coincide', async () => {
    // 1 USDT (6 decimals) is 1_000_000 units; the order wants 1_000_000 nanoTON = 0.001 TON.
    const order = await seedOrder({ currency: 'TON', amount: 1_000_000n })
    const result = await applyPayment(db, event(usdtCandidate({ amount: 1_000_000n })), {
      touchCursor: true,
      now,
    })
    expect(result).toMatchObject({
      status: 'unmatched',
      reason: 'currency_mismatch',
      orderId: order.id,
    })
    const s = await snapshot()
    expect(s.orders[0]?.status).toBe('pending')
    expect(s.notifications).toHaveLength(0)
    expect(s.payments[0]).toMatchObject({
      currency: 'USDT',
      status: 'unmatched',
      orderId: order.id,
    })
  })

  it('never credits TON for a USDT order', async () => {
    await seedOrder({ currency: 'USDT', amount: 5_000_000n })
    const result = await applyPayment(db, event(tonCandidate({ amount: 5_000_000_000n })), {
      touchCursor: true,
      now,
    })
    expect(result).toMatchObject({ status: 'unmatched', reason: 'currency_mismatch' })
    expect((await snapshot()).orders[0]?.status).toBe('pending')
  })

  it('rejects a jetton from another master for a USDT order', async () => {
    await seedOrder({ currency: 'USDT' })
    const result = await applyPayment(db, event(usdtCandidate({ jettonMaster: OTHER_MASTER })), {
      touchCursor: true,
      now,
    })
    expect(result).toMatchObject({ status: 'unmatched', reason: 'currency_mismatch' })
    expect((await snapshot()).orders[0]?.status).toBe('pending')
  })

  it('pays a USDT order from a matching jetton transfer', async () => {
    const order = await seedOrder({ currency: 'USDT' })
    const result = await applyPayment(db, event(usdtCandidate()), { touchCursor: true, now })
    expect(result).toMatchObject({ status: 'matched', orderId: order.id })
    const s = await snapshot()
    expect(s.orders[0]?.status).toBe('paid')
    expect(s.payments[0]).toMatchObject({ jettonMaster: MASTER, account: JETTON_WALLET })
  })

  it('records unknown, unrelated and missing comments as unmatched with the right reason', async () => {
    await seedOrder()
    expect(
      await applyPayment(db, event(tonCandidate({ comment: OTHER_ORDER_ID })), {
        touchCursor: true,
        now,
      }),
    ).toMatchObject({ status: 'unmatched', reason: 'order_not_found', orderId: null })
    expect(
      await applyPayment(db, event(tonCandidate({ comment: 'thanks!' }), { txLt: 201n }), {
        touchCursor: true,
        now,
      }),
    ).toMatchObject({ status: 'unmatched', reason: 'order_not_found', orderId: null })
    expect(
      await applyPayment(db, event(tonCandidate({ comment: null }), { txLt: 202n }), {
        touchCursor: true,
        now,
      }),
    ).toMatchObject({ status: 'unmatched', reason: 'no_comment', orderId: null })
    expect(
      await applyPayment(db, event(tonCandidate({ comment: '   ' }), { txLt: 203n }), {
        touchCursor: true,
        now,
      }),
    ).toMatchObject({ status: 'unmatched', reason: 'no_comment', orderId: null })
    const s = await snapshot()
    expect(s.orders[0]?.status).toBe('pending')
    expect(s.payments).toHaveLength(4)
    expect(s.notifications).toHaveLength(0)
  })

  it('matches a comment with surrounding whitespace and uppercase letters', async () => {
    const order = await seedOrder()
    const result = await applyPayment(
      db,
      event(tonCandidate({ comment: `  ${ORDER_ID.toUpperCase()}\n` })),
      { touchCursor: true, now },
    )
    expect(result).toMatchObject({ status: 'matched', orderId: order.id })
    // The ledger keeps the comment as received.
    expect((await snapshot()).payments[0]?.comment).toBe(`  ${ORDER_ID.toUpperCase()}\n`)
  })

  it('records a second transaction for a paid order as order_already_paid', async () => {
    const order = await seedOrder()
    await applyPayment(db, event(tonCandidate()), { touchCursor: true, now })
    const second = await applyPayment(db, event(tonCandidate(), { txLt: 201n }), {
      touchCursor: true,
      now,
    })
    expect(second).toMatchObject({
      status: 'unmatched',
      reason: 'order_already_paid',
      orderId: order.id,
    })
    const s = await snapshot()
    expect(s.payments.filter((p) => p.status === 'matched')).toHaveLength(1)
    expect(s.notifications).toHaveLength(1)
  })

  it('pays an expired order and flags it as late', async () => {
    await seedOrder({ status: 'expired', expiresAt: new Date(now.getTime() - 60_000) })
    const result = await applyPayment(db, event(tonCandidate()), { touchCursor: true, now })
    expect(result).toMatchObject({ status: 'matched' })
    const s = await snapshot()
    expect(s.orders[0]).toMatchObject({ status: 'paid', paidLate: true, paidAt: txNow })
    expect(s.notifications).toHaveLength(1)
  })

  it('flags a payment that arrived after the deadline as late even before the expirer ran', async () => {
    await seedOrder({ status: 'pending', expiresAt: new Date(txNow.getTime() - 1) })
    await applyPayment(db, event(tonCandidate()), { touchCursor: true, now })
    expect((await snapshot()).orders[0]).toMatchObject({ status: 'paid', paidLate: true })
  })

  it('does not pay a cancelled order', async () => {
    const order = await seedOrder({ status: 'cancelled' })
    const result = await applyPayment(db, event(tonCandidate()), { touchCursor: true, now })
    expect(result).toMatchObject({
      status: 'unmatched',
      reason: 'order_cancelled',
      orderId: order.id,
    })
    const s = await snapshot()
    expect(s.orders[0]?.status).toBe('cancelled')
    expect(s.notifications).toHaveLength(0)
  })

  it('matches a payment from another wallet but flags the payer mismatch', async () => {
    await seedOrder({ payerAddress: PAYER })
    const result = await applyPayment(db, event(tonCandidate({ sender: STRANGER })), {
      touchCursor: true,
      now,
    })
    expect(result).toMatchObject({ status: 'matched' })
    expect((await snapshot()).payments[0]?.payerMismatch).toBe(true)
  })

  it('does not flag a mismatch when the order has no payer address or the sender is unknown', async () => {
    await seedOrder({ payerAddress: null })
    await applyPayment(db, event(tonCandidate({ sender: STRANGER })), { touchCursor: true, now })
    await seedOrder({ id: OTHER_ORDER_ID.replace(/z/g, 'y'), payerAddress: PAYER })
    await applyPayment(
      db,
      event(tonCandidate({ sender: null, comment: OTHER_ORDER_ID.replace(/z/g, 'y') }), {
        txLt: 201n,
      }),
      { touchCursor: true, now },
    )
    const s = await snapshot()
    expect(s.payments.map((p) => p.payerMismatch)).toEqual([false, false])
  })

  it('keeps the aborted-non-bounceable flag on a matched row as its reason', async () => {
    await seedOrder()
    const result = await applyPayment(db, event(tonCandidate({ abortedNonBounceable: true })), {
      touchCursor: true,
      now,
    })
    expect(result).toMatchObject({ status: 'matched', reason: 'aborted_nonbounceable' })
  })
})

describe('applyPayment: ignored rows', () => {
  const foreign: Ignored = {
    kind: 'ignored',
    reason: 'unsupported_asset',
    currency: null,
    jettonMaster: null,
    sourceWallet: rawAddress('99'),
    amount: 7_500_000n,
    sender: PAYER,
    comment: ORDER_ID,
  }

  it('records an unsupported asset that names a pending order without paying it', async () => {
    const order = await seedOrder()
    const result = await applyPayment(db, event(foreign), { touchCursor: true, now })
    expect(result).toMatchObject({
      status: 'ignored',
      reason: 'unsupported_asset',
      orderId: null,
      notified: false,
    })
    const s = await snapshot()
    expect(s.payments[0]).toMatchObject({
      status: 'ignored',
      reason: 'unsupported_asset',
      currency: null,
      sourceWallet: rawAddress('99'),
      amount: 7_500_000n,
      comment: ORDER_ID,
      orderId: null,
    })
    expect(s.orders.find((o) => o.id === order.id)?.status).toBe('pending')
    expect(s.notifications).toHaveLength(0)
    // The cursor still moves: the row was fully handled.
    expect(s.cursors.find((c) => c.account === MERCHANT)).toMatchObject({ lastLt: 200n })
  })

  it('records a mint from the master as ignored with the USDT asset', async () => {
    const mint: Ignored = {
      kind: 'ignored',
      reason: 'from_master',
      currency: 'USDT',
      jettonMaster: MASTER,
      sourceWallet: MASTER,
      amount: 1_000_000_000n,
      sender: null,
      comment: null,
    }
    const result = await applyPayment(db, event(mint), { touchCursor: false, now })
    expect(result).toMatchObject({ status: 'ignored', reason: 'from_master' })
    expect((await snapshot()).payments[0]).toMatchObject({ currency: 'USDT', jettonMaster: MASTER })
  })
})

describe('applyPayment: concurrency on two connections', () => {
  let other: DbHandle

  beforeAll(() => {
    other = createTestDb()
  })

  afterAll(async () => {
    await other.close()
  })

  it('applies the same transaction exactly once when two workers race', async () => {
    const order = await seedOrder()
    const ev = event(tonCandidate())
    const results = await Promise.all([
      applyPayment(db, ev, { touchCursor: true, now }),
      applyPayment(other.db, ev, { touchCursor: true, now }),
    ])
    const duplicates = results.filter((r) => r.duplicate)
    const applied = results.filter((r) => !r.duplicate)
    expect(duplicates).toHaveLength(1)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ status: 'matched', orderId: order.id })

    const s = await snapshot()
    expect(s.payments).toHaveLength(1)
    expect(s.orders[0]?.status).toBe('paid')
    expect(s.notifications).toHaveLength(1)
    expect(s.cursors.find((c) => c.account === MERCHANT)).toMatchObject({
      lastLt: 200n,
      lastHash: ev.txHash,
    })
  })

  it('pays an order once when two different transactions for it race', async () => {
    const order = await seedOrder()
    const first = event(tonCandidate(), { txLt: 200n })
    const second = event(tonCandidate(), { txLt: 201n })
    const results = await Promise.all([
      applyPayment(db, first, { touchCursor: true, now }),
      applyPayment(other.db, second, { touchCursor: true, now }),
    ])
    const statuses = results.map((r) => (r.duplicate ? 'duplicate' : r.status)).sort()
    expect(statuses).toEqual(['matched', 'unmatched'])
    const reasons = results.map((r) => (r.duplicate ? null : r.reason))
    expect(reasons).toContain('order_already_paid')

    const s = await snapshot()
    expect(s.payments).toHaveLength(2)
    expect(s.payments.filter((p) => p.status === 'matched')).toHaveLength(1)
    expect(s.orders.find((o) => o.id === order.id)?.status).toBe('paid')
    expect(s.notifications).toHaveLength(1)
    expect(s.cursors.find((c) => c.account === MERCHANT)?.lastLt).toBe(201n)
  })

  it('waits for an in-flight insert of the same transaction and then reports duplicate', async () => {
    const order = await seedOrder()
    const ev = event(tonCandidate())
    // A raw client holds an uncommitted ledger row for the same tx_hash, as a concurrent
    // worker would in the middle of its own applyPayment.
    const client = await other.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO payments (account, tx_hash, tx_lt, tx_now, mc_block_seqno, currency, amount, status, raw)
         VALUES ($1, $2, $3, $4, $5, 'TON', $6, 'unmatched', '{}'::jsonb)`,
        [MERCHANT, ev.txHash, '200', txNow, '1', '1500000000'],
      )

      const racing = applyPayment(db, ev, { touchCursor: true, now })
      const settled = await Promise.race([
        racing.then(() => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 300)),
      ])
      // The insert is blocked on the unique index until the other transaction decides.
      expect(settled).toBe('blocked')

      await client.query('COMMIT')
      expect(await racing).toEqual({ duplicate: true })
    } finally {
      client.release()
    }
    const s = await snapshot()
    expect(s.payments).toHaveLength(1)
    // The raw row was never settled by anyone, so the order stays pending: exactly the state a
    // crashed worker would leave for the next poll (whose applyPayment then sees a duplicate).
    expect(s.orders.find((o) => o.id === order.id)?.status).toBe('pending')
  })

  it('proceeds normally when the in-flight insert of the same transaction rolls back', async () => {
    await seedOrder()
    const ev = event(tonCandidate())
    const client = await other.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO payments (account, tx_hash, tx_lt, tx_now, mc_block_seqno, currency, amount, status, raw)
         VALUES ($1, $2, $3, $4, $5, 'TON', $6, 'unmatched', '{}'::jsonb)`,
        [MERCHANT, ev.txHash, '200', txNow, '1', '1500000000'],
      )
      const racing = applyPayment(db, ev, { touchCursor: true, now })
      await client.query('ROLLBACK')
      expect(await racing).toMatchObject({ duplicate: false, status: 'matched' })
    } finally {
      client.release()
    }
    const s = await snapshot()
    expect(s.payments).toHaveLength(1)
    expect(s.orders[0]?.status).toBe('paid')
  })

  it('serialises many concurrent applications of one transaction', async () => {
    await seedOrder()
    const ev = event(tonCandidate())
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        applyPayment(i % 2 === 0 ? db : other.db, ev, { touchCursor: true, now }),
      ),
    )
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1)
    expect((await snapshot()).payments).toHaveLength(1)
  })
})

describe('applyPayment: atomicity and the cursor', () => {
  it('rolls back the ledger row, the order and the notification when a later step fails', async () => {
    const order = await seedOrder()
    // A stale `matched` row for the same order makes the partial unique index reject the
    // UPDATE in step 4, after the insert (step 1) and the order CAS already happened.
    await db.insert(payments).values({
      account: MERCHANT,
      txHash: 'f'.repeat(64),
      txLt: 150n,
      txNow,
      mcBlockSeqno: 1n,
      currency: 'TON',
      amount: 1n,
      status: 'matched',
      orderId: order.id,
      raw: {},
    })
    const before = await snapshot()

    const error = await applyPayment(db, event(tonCandidate()), { touchCursor: true, now }).catch(
      (e: unknown) => e,
    )
    expect(pgErrorCode(error)).toBe(PG_UNIQUE_VIOLATION)

    const after = await snapshot()
    expect(after).toEqual(before)
    expect(after.payments).toHaveLength(1)
    expect(after.orders[0]?.status).toBe('pending')
    expect(after.notifications).toHaveLength(0)
    expect(after.cursors.find((c) => c.account === MERCHANT)).toMatchObject({
      lastLt: 100n,
      lastHash: 'a'.repeat(64),
    })
  })

  it('rolls back the ledger row when the cursor cannot be moved', async () => {
    await seedOrder()
    await db.delete(scanCursors).where(eq(scanCursors.account, MERCHANT))
    await expect(
      applyPayment(db, event(tonCandidate()), { touchCursor: true, now }),
    ).rejects.toThrow(/no scan cursor/)
    const s = await snapshot()
    expect(s.payments).toHaveLength(0)
    expect(s.orders[0]?.status).toBe('pending')
    expect(s.notifications).toHaveLength(0)
  })

  it('leaves the cursor alone with touchCursor: false', async () => {
    await seedOrder()
    await applyPayment(db, event(tonCandidate()), { touchCursor: false, now })
    expect((await snapshot()).cursors.find((c) => c.account === MERCHANT)).toMatchObject({
      lastLt: 100n,
      lastHash: 'a'.repeat(64),
    })
  })

  it('moves the cursor forward but never back', async () => {
    await seedOrder()
    const ahead = event(tonCandidate(), { txLt: 300n })
    await applyPayment(db, ahead, { touchCursor: true, now })
    expect((await snapshot()).cursors.find((c) => c.account === MERCHANT)).toMatchObject({
      lastLt: 300n,
      lastHash: ahead.txHash,
    })

    const behind = event(tonCandidate({ comment: null }), { txLt: 250n })
    await applyPayment(db, behind, { touchCursor: true, now })
    expect((await snapshot()).cursors.find((c) => c.account === MERCHANT)).toMatchObject({
      lastLt: 300n,
      lastHash: ahead.txHash,
    })
  })

  it('moves only the cursor of the scanned account', async () => {
    await seedOrder({ currency: 'USDT' })
    await applyPayment(db, event(usdtCandidate(), { txLt: 400n }), { touchCursor: true, now })
    const cursors = (await snapshot()).cursors
    expect(cursors.find((c) => c.account === JETTON_WALLET)?.lastLt).toBe(400n)
    expect(cursors.find((c) => c.account === MERCHANT)?.lastLt).toBe(100n)
  })

  it('rejects two different hashes with the same (account, lt) instead of recording both', async () => {
    await seedOrder()
    await applyPayment(db, event(tonCandidate(), { txLt: 200n }), { touchCursor: true, now })
    const error = await applyPayment(db, event(tonCandidate({ comment: null }), { txLt: 200n }), {
      touchCursor: true,
      now,
    }).catch((e: unknown) => e)
    expect(pgErrorCode(error)).toBe(PG_UNIQUE_VIOLATION)
    expect((await snapshot()).payments).toHaveLength(1)
  })
})
