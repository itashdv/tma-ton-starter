import {
  notifications,
  orders,
  payments,
  scanCursors,
  users,
  type Db,
  type DbHandle,
} from '@tma/db'
import { createTestDb, truncateAll } from '@tma/db/testing'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyPayment } from '../../src/services/payments'
import { normalizeHash } from '../../src/ton/hash'
import { createToncenterClient, type ToncenterClient } from '../../src/ton/toncenter'
import type { ToncenterTransaction } from '../../src/ton/toncenter.schemas'
import type { ClassifyContext } from '../../src/worker/classify'
import {
  rescanRecentOnce,
  scanAccountOnce,
  type ScanAccount,
  type ScannerDeps,
} from '../../src/worker/scanner'
import { seedProduct } from '../helpers/auth'
import { startFakeToncenter, type FakeToncenter } from '../helpers/fake-toncenter'
import {
  chain,
  excesses,
  jettonInternalTransfer,
  jettonNotification,
  nonFinal,
  rawAddress,
  tonTransfer,
  withNow,
} from '../helpers/tx-factory'

const MERCHANT = rawAddress('aa')
const JETTON_WALLET = rawAddress('bb')
const MASTER = rawAddress('cc')
const PAYER = rawAddress('11')
const PAYER_JETTON_WALLET = rawAddress('22')
const USER_ID = 279_058_397n
const ORDER_ID = '0123456789abcdef'
const USDT_ORDER_ID = 'abcdefghjkmnpqrs'

const now = new Date('2026-09-16T12:00:00Z')
const nowSec = Math.floor(now.getTime() / 1000)

const ctx: ClassifyContext = {
  merchantRaw: MERCHANT,
  merchantJettonWalletRaw: JETTON_WALLET,
  usdtMasterRaw: MASTER,
  minRecordNano: 1_000_000n,
}
const MAIN: ScanAccount = { account: MERCHANT, label: 'ton_wallet' }
const JETTON: ScanAccount = { account: JETTON_WALLET, label: 'usdt_jetton_wallet' }

/** The transaction the cursor points at when a test starts (head of the account). */
const HEAD = tonTransfer({ account: MERCHANT, lt: 100n, value: 10n })
const JETTON_HEAD = jettonInternalTransfer({ account: JETTON_WALLET, lt: 100n, comment: null })

let handle: DbHandle
let db: Db
let fake: FakeToncenter
let ton: ToncenterClient
const slept: number[] = []

beforeAll(() => {
  handle = createTestDb()
  db = handle.db
})

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  fake = await startFakeToncenter()
  slept.length = 0
  ton = createToncenterClient({
    baseUrl: fake.url,
    apiKey: 'test-key',
    policy: 'worker',
    sleep: async (ms) => {
      slept.push(ms)
    },
    random: () => 0.5,
  })
  await truncateAll(db)
  await db.insert(users).values({ telegramId: USER_ID, firstName: 'Test' })
  // Registered at lt 10 (the floor), already advanced to lt 100 (the head row).
  await db.insert(scanCursors).values([
    {
      account: MERCHANT,
      label: 'ton_wallet',
      startLt: 10n,
      lastLt: 100n,
      lastHash: normalizeHash(HEAD.hash),
    },
    {
      account: JETTON_WALLET,
      label: 'usdt_jetton_wallet',
      startLt: 10n,
      lastLt: 100n,
      lastHash: normalizeHash(JETTON_HEAD.hash),
    },
  ])
})

afterEach(async () => {
  await fake.close()
})

function deps(overrides: Partial<ScannerDeps> = {}): ScannerDeps {
  return {
    db,
    ton,
    log: pino({ level: 'silent' }),
    now: () => now,
    batchLimit: 100,
    ctx,
    ...overrides,
  }
}

async function seedOrder(
  options: { id?: string; currency?: 'TON' | 'USDT'; amount?: bigint } = {},
) {
  const currency = options.currency ?? 'TON'
  const product = await seedProduct(db, { slug: `p-${options.id ?? ORDER_ID}` })
  const [order] = await db
    .insert(orders)
    .values({
      id: options.id ?? ORDER_ID,
      userId: USER_ID,
      productId: product.id,
      productTitle: product.title,
      currency,
      amount: options.amount ?? (currency === 'TON' ? 1_500_000_000n : 5_000_000n),
      jettonMaster: currency === 'USDT' ? MASTER : null,
      merchantAddress: MERCHANT,
      payerAddress: PAYER,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!order) throw new Error('order not inserted')
  return order
}

function serve(rows: ToncenterTransaction[]): void {
  fake.setTransactions([HEAD, JETTON_HEAD, ...rows])
}

async function cursorOf(account: string) {
  const [row] = await db.select().from(scanCursors).where(eq(scanCursors.account, account))
  if (!row) throw new Error('cursor missing')
  return row
}

const transactionRequests = () => fake.requests.filter((r) => r.path === '/transactions')

describe('scanAccountOnce: cursor semantics', () => {
  it('asks for the tail of the chain from the cursor with the API key', async () => {
    serve([])
    const summary = await scanAccountOnce(deps(), MAIN)
    const request = transactionRequests()[0]
    expect(request?.query.get('account')).toBe(MERCHANT)
    expect(request?.query.get('start_lt')).toBe('100')
    expect(request?.query.get('sort')).toBe('asc')
    expect(request?.query.get('limit')).toBe('100')
    expect(request?.query.get('offset')).toBeNull()
    expect(request?.headers['x-api-key']).toBe('test-key')
    // Inclusive start: the head row comes back and is skipped by hash.
    expect(summary).toMatchObject({ fetched: 1, applied: 0, skipped: 0, error: null })
    expect(await cursorOf(MERCHANT)).toMatchObject({
      lastLt: 100n,
      lastHash: normalizeHash(HEAD.hash),
      lastPolledAt: now,
      lastError: null,
    })
  })

  it('never fetches or records history below the registration head', async () => {
    await seedOrder()
    // A perfectly valid payment that happened before the worker first started.
    serve([tonTransfer({ account: MERCHANT, comment: ORDER_ID, lt: 50n })])
    const summary = await scanAccountOnce(deps(), MAIN)
    expect(summary).toMatchObject({ fetched: 1, applied: 0, skipped: 0 })
    expect(await db.select().from(payments)).toHaveLength(0)
    expect((await db.select().from(orders))[0]?.status).toBe('pending')
  })

  it('omits start_lt for a fresh account (cursor at 0)', async () => {
    await db
      .update(scanCursors)
      .set({ lastLt: 0n, lastHash: null })
      .where(eq(scanCursors.account, MERCHANT))
    serve([])
    await scanAccountOnce(deps(), MAIN)
    expect(transactionRequests()[0]?.query.get('start_lt')).toBeNull()
  })

  it('records one payment out of three rows (TON, own notification, excesses) and moves the cursor', async () => {
    const order = await seedOrder()
    const rows = chain(
      [
        tonTransfer({ account: MERCHANT, source: PAYER, comment: ORDER_ID }),
        jettonNotification({ account: MERCHANT, source: JETTON_WALLET, comment: ORDER_ID }),
        excesses({ account: MERCHANT, source: JETTON_WALLET }),
      ],
      101n,
    )
    serve(rows)

    const summary = await scanAccountOnce(deps(), MAIN)
    expect(summary).toMatchObject({
      fetched: 4,
      applied: 1,
      duplicates: 0,
      skipped: 2,
      error: null,
    })
    expect(await db.select().from(payments)).toHaveLength(1)
    expect((await db.select().from(orders))[0]).toMatchObject({ id: order.id, status: 'paid' })
    expect(await db.select().from(notifications)).toHaveLength(1)
    expect(await cursorOf(MERCHANT)).toMatchObject({
      lastLt: 103n,
      lastHash: normalizeHash(rows[2]?.hash ?? ''),
    })
  })

  it('does not record anything twice on a second poll', async () => {
    await seedOrder()
    const rows = chain([tonTransfer({ account: MERCHANT, comment: ORDER_ID })], 101n)
    serve(rows)
    await scanAccountOnce(deps(), MAIN)
    const before = await cursorOf(MERCHANT)

    const again = await scanAccountOnce(deps(), MAIN)
    expect(again).toMatchObject({ fetched: 1, applied: 0, duplicates: 0, skipped: 0 })
    expect(transactionRequests().at(-1)?.query.get('start_lt')).toBe('101')
    expect(await db.select().from(payments)).toHaveLength(1)
    expect((await cursorOf(MERCHANT)).lastLt).toBe(before.lastLt)
  })

  it('moves the cursor over a page of skipped rows and skips the last one by hash next time', async () => {
    const rows = chain(
      [
        excesses({ account: MERCHANT, source: JETTON_WALLET }),
        jettonNotification({ account: MERCHANT, source: JETTON_WALLET }),
      ],
      101n,
    )
    serve(rows)
    const first = await scanAccountOnce(deps(), MAIN)
    expect(first).toMatchObject({ skipped: 2, applied: 0 })
    expect(await cursorOf(MERCHANT)).toMatchObject({
      lastLt: 102n,
      lastHash: normalizeHash(rows[1]?.hash ?? ''),
    })

    const second = await scanAccountOnce(deps(), MAIN)
    expect(second).toMatchObject({ fetched: 1, skipped: 0, applied: 0 })
    expect(await db.select().from(payments)).toHaveLength(0)
  })

  it('pages with offset when a page is full', async () => {
    const rows = chain(
      Array.from({ length: 5 }, () => excesses({ account: MERCHANT, source: JETTON_WALLET })),
      101n,
    )
    serve(rows)
    const summary = await scanAccountOnce(deps({ batchLimit: 3 }), MAIN)
    // Page 1: head + rows 101..102 (3 rows), page 2: 103..105 (3 rows), page 3: empty.
    const requests = transactionRequests()
    expect(requests.map((r) => r.query.get('offset'))).toEqual([null, '3', '6'])
    expect(requests.every((r) => r.query.get('start_lt') === '100')).toBe(true)
    expect(summary).toMatchObject({ fetched: 6, skipped: 5, moreAvailable: false })
    expect((await cursorOf(MERCHANT)).lastLt).toBe(105n)
  })

  it('stops after the current page when the stop signal fires, keeping the cursor consistent', async () => {
    const controller = new AbortController()
    const rows = chain(
      Array.from({ length: 4 }, () => excesses({ account: MERCHANT, source: JETTON_WALLET })),
      101n,
    )
    serve(rows)
    // Abort while the first page is being fetched: the page is processed, the next is not.
    const stopping = createToncenterClient({
      baseUrl: fake.url,
      policy: 'worker',
      sleep: async () => {},
      fetch: async (input, init) => {
        controller.abort()
        return fetch(input, init)
      },
    })
    const summary = await scanAccountOnce(
      deps({ ton: stopping, batchLimit: 2, signal: controller.signal }),
      MAIN,
    )
    expect(summary).toMatchObject({ fetched: 2, moreAvailable: true, error: null })
    expect((await cursorOf(MERCHANT)).lastLt).toBe(101n)
  })

  it('stops at the page budget and continues on the next poll', async () => {
    await seedOrder()
    const rows = chain(
      [
        excesses({ account: MERCHANT, source: JETTON_WALLET }),
        excesses({ account: MERCHANT, source: JETTON_WALLET }),
        excesses({ account: MERCHANT, source: JETTON_WALLET }),
        tonTransfer({ account: MERCHANT, comment: ORDER_ID }),
      ],
      101n,
    )
    serve(rows)
    const first = await scanAccountOnce(deps({ batchLimit: 2, maxPages: 1 }), MAIN)
    expect(first).toMatchObject({ fetched: 2, moreAvailable: true, applied: 0 })
    expect((await cursorOf(MERCHANT)).lastLt).toBe(101n)

    const second = await scanAccountOnce(deps({ batchLimit: 2, maxPages: 5 }), MAIN)
    expect(second).toMatchObject({ applied: 1, moreAvailable: false })
    expect((await cursorOf(MERCHANT)).lastLt).toBe(104n)
  })
})

describe('scanAccountOnce: finality', () => {
  it('stops at the first non-final row and leaves the cursor on the previous one', async () => {
    await seedOrder()
    const rows = chain(
      [
        excesses({ account: MERCHANT, source: JETTON_WALLET }),
        tonTransfer({ account: MERCHANT, comment: ORDER_ID }),
        excesses({ account: MERCHANT, source: JETTON_WALLET }),
      ],
      101n,
    )
    const pendingPayment = nonFinal(rows[1] as ToncenterTransaction, 'confirmed')
    serve([rows[0] as ToncenterTransaction, pendingPayment, rows[2] as ToncenterTransaction])

    const summary = await scanAccountOnce(deps(), MAIN)
    expect(summary).toMatchObject({ fetched: 4, skipped: 1, applied: 0, stoppedAtNonFinal: true })
    expect(await db.select().from(payments)).toHaveLength(0)
    expect(await cursorOf(MERCHANT)).toMatchObject({ lastLt: 101n, lastError: null })

    // Once the block is finalized the payment is picked up where the cursor stopped.
    serve(rows)
    const next = await scanAccountOnce(deps(), MAIN)
    expect(next).toMatchObject({ applied: 1, skipped: 1, stoppedAtNonFinal: false })
    expect((await db.select().from(orders))[0]?.status).toBe('paid')
    expect((await cursorOf(MERCHANT)).lastLt).toBe(103n)
  })

  it('treats an emulated row as non-final', async () => {
    await seedOrder()
    const [row] = chain([tonTransfer({ account: MERCHANT, comment: ORDER_ID })], 101n)
    serve([{ ...(row as ToncenterTransaction), emulated: true }])
    const summary = await scanAccountOnce(deps(), MAIN)
    expect(summary).toMatchObject({ applied: 0, stoppedAtNonFinal: true })
    expect(await db.select().from(payments)).toHaveLength(0)
  })
})

describe('scanAccountOnce: failures', () => {
  it('stops the batch on a settlement error, keeps the cursor on the last good row and retries next poll', async () => {
    await seedOrder()
    await seedOrder({ id: USDT_ORDER_ID.replace(/s/g, 't') })
    const rows = chain(
      [
        tonTransfer({ account: MERCHANT, comment: 'thanks' }),
        tonTransfer({ account: MERCHANT, comment: ORDER_ID }),
        tonTransfer({ account: MERCHANT, comment: USDT_ORDER_ID.replace(/s/g, 't') }),
      ],
      101n,
    )
    serve(rows)

    let calls = 0
    const failing: ScannerDeps['apply'] = async (database, event, options) => {
      calls += 1
      if (calls === 2) throw new Error('connection reset while settling')
      return applyPayment(database, event, options)
    }
    const first = await scanAccountOnce(deps({ apply: failing }), MAIN)
    expect(first.error).toMatch(/connection reset/)
    expect(first).toMatchObject({ applied: 1 })
    expect(await db.select().from(payments)).toHaveLength(1)
    expect(await cursorOf(MERCHANT)).toMatchObject({
      lastLt: 101n,
      lastHash: normalizeHash(rows[0]?.hash ?? ''),
      lastPolledAt: now,
    })
    expect((await cursorOf(MERCHANT)).lastError).toMatch(/connection reset/)

    const second = await scanAccountOnce(deps(), MAIN)
    expect(second).toMatchObject({ applied: 2, error: null })
    expect(transactionRequests().at(-1)?.query.get('start_lt')).toBe('101')
    expect(await db.select().from(payments)).toHaveLength(3)
    expect((await db.select().from(orders)).map((o) => o.status)).toEqual(['paid', 'paid'])
    expect(await cursorOf(MERCHANT)).toMatchObject({ lastLt: 103n, lastError: null })
  })

  it('survives a 429 and continues after the client slept', async () => {
    await seedOrder()
    serve(chain([tonTransfer({ account: MERCHANT, comment: ORDER_ID })], 101n))
    fake.enqueue('/transactions', { kind: 'status', status: 429, body: 'Ratelimit exceed' })
    const summary = await scanAccountOnce(deps(), MAIN)
    expect(summary).toMatchObject({ applied: 1, error: null })
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThan(0)
  })

  it('records the error and keeps the cursor when toncenter stays unavailable', async () => {
    await seedOrder()
    serve(chain([tonTransfer({ account: MERCHANT, comment: ORDER_ID })], 101n))
    for (let i = 0; i < 5; i += 1) {
      fake.enqueue('/transactions', { kind: 'status', status: 429, body: 'Ratelimit exceed' })
    }
    const summary = await scanAccountOnce(deps(), MAIN)
    expect(summary.error).toMatch(/429/)
    expect(summary).toMatchObject({ applied: 0, fetched: 0 })
    expect(await db.select().from(payments)).toHaveLength(0)
    expect(await cursorOf(MERCHANT)).toMatchObject({
      lastLt: 100n,
      lastHash: normalizeHash(HEAD.hash),
      lastPolledAt: now,
    })
    expect((await cursorOf(MERCHANT)).lastError).toMatch(/429/)
  })

  it('refuses to scan an account without a cursor', async () => {
    await expect(
      scanAccountOnce(deps(), { account: rawAddress('ee'), label: 'ton_wallet' }),
    ).rejects.toThrow(/no scan cursor/)
  })
})

describe('scanAccountOnce: two accounts', () => {
  it('keeps independent cursors and settles a USDT order from the jetton wallet', async () => {
    const tonOrder = await seedOrder()
    const usdtOrder = await seedOrder({ id: USDT_ORDER_ID, currency: 'USDT', amount: 5_000_000n })
    const mainRows = chain([tonTransfer({ account: MERCHANT, comment: ORDER_ID })], 101n)
    const jettonRows = chain(
      [
        jettonInternalTransfer({
          account: JETTON_WALLET,
          source: PAYER_JETTON_WALLET,
          from: PAYER,
          amount: 5_000_000n,
          comment: USDT_ORDER_ID,
        }),
        jettonInternalTransfer({ account: JETTON_WALLET, from: PAYER, comment: null }),
      ],
      101n,
    )
    serve([...mainRows, ...jettonRows])

    const main = await scanAccountOnce(deps(), MAIN)
    expect(main).toMatchObject({ fetched: 2, applied: 1 })
    expect((await cursorOf(JETTON_WALLET)).lastLt).toBe(100n)

    const jetton = await scanAccountOnce(deps(), JETTON)
    expect(jetton).toMatchObject({ fetched: 3, applied: 2 })
    expect((await cursorOf(MERCHANT)).lastLt).toBe(101n)
    expect((await cursorOf(JETTON_WALLET)).lastLt).toBe(102n)

    const rows = await db.select().from(payments)
    expect(rows.find((p) => p.orderId === usdtOrder.id)).toMatchObject({
      status: 'matched',
      currency: 'USDT',
      jettonMaster: MASTER,
      account: JETTON_WALLET,
      senderAddress: PAYER,
    })
    expect(rows.find((p) => p.orderId === tonOrder.id)).toMatchObject({
      status: 'matched',
      currency: 'TON',
    })
    expect(rows.find((p) => p.comment === null)).toMatchObject({
      status: 'unmatched',
      reason: 'no_comment',
    })
    const statuses = Object.fromEntries(
      (await db.select().from(orders)).map((o) => [o.id, o.status]),
    )
    expect(statuses).toEqual({ [tonOrder.id]: 'paid', [usdtOrder.id]: 'paid' })
  })
})

describe('rescanRecentOnce', () => {
  it('re-reads the window by start_utime, records nothing twice and never moves the cursor', async () => {
    await seedOrder()
    const rows = chain(
      [withNow(tonTransfer({ account: MERCHANT, comment: ORDER_ID }), nowSec - 60)],
      101n,
    )
    serve(rows)
    await scanAccountOnce(deps(), MAIN)
    const before = await cursorOf(MERCHANT)

    const summary = await rescanRecentOnce(deps(), MAIN, 1800)
    const request = transactionRequests().at(-1)
    expect(request?.query.get('start_utime')).toBe(String(nowSec - 1800))
    expect(request?.query.get('end_lt')).toBe('101')
    expect(request?.query.get('start_lt')).toBeNull()
    expect(summary).toMatchObject({ fetched: 1, recovered: 0, duplicates: 1, error: null })
    expect(await db.select().from(payments)).toHaveLength(1)
    expect(await cursorOf(MERCHANT)).toEqual(before)
  })

  it('recovers a final row between the registration floor and the cursor', async () => {
    await seedOrder()
    // The cursor already sits at lt 100; a transaction at lt 50 the indexer served late.
    const late = withNow(
      tonTransfer({ account: MERCHANT, comment: ORDER_ID, lt: 50n }),
      nowSec - 30,
    )
    serve([late])
    const summary = await rescanRecentOnce(deps(), MAIN, 1800)
    expect(summary).toMatchObject({ recovered: 1, duplicates: 0 })
    expect((await db.select().from(orders))[0]?.status).toBe('paid')
    expect(await cursorOf(MERCHANT)).toMatchObject({
      lastLt: 100n,
      lastHash: normalizeHash(HEAD.hash),
    })
  })

  it('never ingests history at or below the registration floor', async () => {
    await seedOrder()
    serve([
      withNow(tonTransfer({ account: MERCHANT, comment: ORDER_ID, lt: 10n }), nowSec - 30),
      withNow(tonTransfer({ account: MERCHANT, comment: ORDER_ID, lt: 5n }), nowSec - 30),
    ])
    const summary = await rescanRecentOnce(deps(), MAIN, 1800)
    expect(summary).toMatchObject({ fetched: 2, recovered: 0, duplicates: 0 })
    expect(await db.select().from(payments)).toHaveLength(0)
    expect((await db.select().from(orders))[0]?.status).toBe('pending')
  })

  it('leaves rows above the cursor and non-final rows to the regular scan', async () => {
    await seedOrder()
    const rows = chain(
      [withNow(tonTransfer({ account: MERCHANT, comment: ORDER_ID }), nowSec - 30)],
      101n,
    )
    serve([
      ...rows,
      nonFinal(
        withNow(tonTransfer({ account: MERCHANT, comment: ORDER_ID, lt: 60n }), nowSec - 30),
      ),
    ])
    const summary = await rescanRecentOnce(deps(), MAIN, 1800)
    // The row above the cursor is excluded by end_lt; the head row is older than the window.
    expect(summary).toMatchObject({ fetched: 1, recovered: 0, duplicates: 0 })
    expect(await db.select().from(payments)).toHaveLength(0)
  })

  it('stops paging when the stop signal fires', async () => {
    const controller = new AbortController()
    controller.abort()
    serve([withNow(tonTransfer({ account: MERCHANT, comment: ORDER_ID, lt: 50n }), nowSec - 30)])
    const summary = await rescanRecentOnce(deps({ signal: controller.signal }), MAIN, 1800)
    expect(summary).toMatchObject({ fetched: 0, recovered: 0 })
    expect(transactionRequests()).toHaveLength(0)
  })
})
