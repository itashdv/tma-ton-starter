import { generateOrderId } from '@tma/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  PG_CHECK_VIOLATION,
  PG_INVALID_TEXT_REPRESENTATION,
  PG_UNIQUE_VIOLATION,
  orders,
  payments,
  pgErrorCode,
  products,
  scanCursors,
  users,
  type Db,
  type DbHandle,
} from '../src/index'
import { runMigrations } from '../src/migrate'
import { createTestDb, getTestDatabaseUrl, truncateAll } from './helpers'

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
})

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return pgErrorCode(error)
  }
}

/** Idempotent within a test: several insertOrder() calls share one user and product. */
async function seedUserAndProduct() {
  const telegramId = 279_058_397n
  await db.insert(users).values({ telegramId, firstName: 'Test' }).onConflictDoNothing()
  await db
    .insert(products)
    .values({ slug: 'guide', title: 'Guide', priceTonNano: 1_500_000_000n })
    .onConflictDoNothing({ target: products.slug })
  const [product] = await db.select().from(products).where(eq(products.slug, 'guide'))
  if (!product) throw new Error('product not inserted')
  return { telegramId, product }
}

async function insertOrder(overrides: Partial<typeof orders.$inferInsert> = {}) {
  const { telegramId, product } = await seedUserAndProduct()
  const [order] = await db
    .insert(orders)
    .values({
      id: generateOrderId(),
      userId: telegramId,
      productId: product.id,
      productTitle: product.title,
      currency: 'TON',
      amount: 1_500_000_000n,
      merchantAddress: '0:AA',
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    })
    .returning()
  if (!order) throw new Error('order not inserted')
  return order
}

function paymentRow(
  overrides: Partial<typeof payments.$inferInsert> = {},
): typeof payments.$inferInsert {
  return {
    account: '0:AA',
    txHash: 'a'.repeat(64),
    txLt: 100n,
    txNow: new Date(),
    mcBlockSeqno: 1n,
    currency: 'TON',
    amount: 1n,
    status: 'unmatched',
    raw: {},
    ...overrides,
  }
}

describe('migrations', () => {
  it('created every table and re-running migrations is a no-op', async () => {
    const before = await db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    )
    await runMigrations(getTestDatabaseUrl())
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)

    const tables = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    )
    const names = tables.rows.map((row) => row.table_name)
    for (const expected of [
      'users',
      'products',
      'orders',
      'payments',
      'scan_cursors',
      'notifications',
    ]) {
      expect(names).toContain(expected)
    }
  })
})

describe('bigint columns', () => {
  it('round-trip telegram ids above 2^32 and amounts up to 10^18', async () => {
    const telegramId = 2n ** 40n + 7n
    await db.insert(users).values({ telegramId, firstName: 'Big' })
    const [user] = await db.select().from(users).where(eq(users.telegramId, telegramId))
    expect(user?.telegramId).toBe(telegramId)

    await insertOrder()
    await db.insert(payments).values(paymentRow({ amount: 10n ** 18n, txLt: 2n ** 60n }))
    const [payment] = await db.select().from(payments)
    expect(payment?.amount).toBe(10n ** 18n)
    expect(payment?.txLt).toBe(2n ** 60n)
  })
})

describe('enums and checks', () => {
  it('rejects an unknown currency', async () => {
    const order = await insertOrder()
    const code = await codeOf(
      db.execute(sql`UPDATE orders SET currency = 'EUR' WHERE id = ${order.id}`),
    )
    expect(code).toBe(PG_INVALID_TEXT_REPRESENTATION)
  })

  it('rejects malformed order ids, USDT without a master, and non-positive amounts', async () => {
    expect(await codeOf(insertOrder({ id: 'ORD_ABC' }))).toBe(PG_CHECK_VIOLATION)
    expect(await codeOf(insertOrder({ currency: 'USDT', jettonMaster: null }))).toBe(
      PG_CHECK_VIOLATION,
    )
    expect(await codeOf(insertOrder({ amount: 0n }))).toBe(PG_CHECK_VIOLATION)
    expect(await codeOf(insertOrder({ amount: -1n }))).toBe(PG_CHECK_VIOLATION)
    expect(
      await codeOf(insertOrder({ currency: 'USDT', jettonMaster: '0:BB', amount: 1_000_000n })),
    ).toBeUndefined()
  })

  it('rejects a product without any price or with a non-positive price', async () => {
    expect(await codeOf(db.insert(products).values({ slug: 'x', title: 'X' }))).toBe(
      PG_CHECK_VIOLATION,
    )
    expect(
      await codeOf(db.insert(products).values({ slug: 'y', title: 'Y', priceTonNano: 0n })),
    ).toBe(PG_CHECK_VIOLATION)
  })

  it('rejects unknown scan cursor labels', async () => {
    const code = await codeOf(
      db.execute(sql`INSERT INTO scan_cursors (account, label) VALUES ('0:AA', 'ton-wallet')`),
    )
    expect(code).toBe(PG_CHECK_VIOLATION)
    expect(
      await codeOf(db.insert(scanCursors).values({ account: '0:BB', label: 'usdt_jetton_wallet' })),
    ).toBeUndefined()
  })

  it('rejects negative payment amounts and non-hex hashes', async () => {
    await insertOrder()
    expect(await codeOf(db.insert(payments).values(paymentRow({ amount: -1n })))).toBe(
      PG_CHECK_VIOLATION,
    )
    expect(await codeOf(db.insert(payments).values(paymentRow({ txHash: 'A'.repeat(64) })))).toBe(
      PG_CHECK_VIOLATION,
    )
    expect(await codeOf(db.insert(payments).values(paymentRow({ txHash: 'abc' })))).toBe(
      PG_CHECK_VIOLATION,
    )
  })
})

describe('uniqueness', () => {
  it('rejects duplicate tx_hash and duplicate (account, tx_lt)', async () => {
    await insertOrder()
    await db.insert(payments).values(paymentRow())
    expect(await codeOf(db.insert(payments).values(paymentRow({ txLt: 101n })))).toBe(
      PG_UNIQUE_VIOLATION,
    )
    expect(await codeOf(db.insert(payments).values(paymentRow({ txHash: 'b'.repeat(64) })))).toBe(
      PG_UNIQUE_VIOLATION,
    )
    expect(
      await codeOf(
        db.insert(payments).values(paymentRow({ txHash: 'b'.repeat(64), account: '0:BB' })),
      ),
    ).toBeUndefined()
  })

  it('allows at most one matched payment per order but any number of other rows', async () => {
    const order = await insertOrder()
    await db
      .insert(payments)
      .values(paymentRow({ orderId: order.id, status: 'unmatched', txHash: 'a'.repeat(64) }))
    await db
      .insert(payments)
      .values(
        paymentRow({ orderId: order.id, status: 'matched', txHash: 'b'.repeat(64), txLt: 101n }),
      )
    expect(
      await codeOf(
        db.insert(payments).values(
          paymentRow({
            orderId: order.id,
            status: 'matched',
            txHash: 'c'.repeat(64),
            txLt: 102n,
          }),
        ),
      ),
    ).toBe(PG_UNIQUE_VIOLATION)
    expect(
      await codeOf(
        db.insert(payments).values(
          paymentRow({
            orderId: order.id,
            status: 'underpaid',
            txHash: 'd'.repeat(64),
            txLt: 103n,
          }),
        ),
      ),
    ).toBeUndefined()
  })

  it('rejects duplicate product slugs', async () => {
    await db.insert(products).values({ slug: 'dup', title: 'A', priceTonNano: 1n })
    expect(
      await codeOf(db.insert(products).values({ slug: 'dup', title: 'B', priceTonNano: 1n })),
    ).toBe(PG_UNIQUE_VIOLATION)
  })
})
