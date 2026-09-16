import { orders, scanCursors, users, type Db, type DbHandle } from '@tma/db'
import { createTestDb, truncateAll } from '@tma/db/testing'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyPayment } from '../../src/services/payments'
import { expireOnce } from '../../src/worker/expirer'
import { seedProduct } from '../helpers/auth'
import { rawAddress } from '../helpers/tx-factory'

const MERCHANT = rawAddress('aa')
const USER_ID = 279_058_397n
const now = new Date('2026-09-16T12:00:00Z')

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
  await db.insert(users).values({ telegramId: USER_ID, firstName: 'Test' })
  await db
    .insert(scanCursors)
    .values({ account: MERCHANT, label: 'ton_wallet', lastLt: 1n, lastHash: null })
})

async function seedOrder(
  id: string,
  status: 'pending' | 'paid' | 'cancelled',
  expiresAt: Date,
): Promise<void> {
  const product = await seedProduct(db, { slug: `p-${id}` })
  await db.insert(orders).values({
    id,
    userId: USER_ID,
    productId: product.id,
    productTitle: product.title,
    currency: 'TON',
    amount: 1_500_000_000n,
    merchantAddress: MERCHANT,
    payerAddress: rawAddress('11'),
    status,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  })
}

const past = new Date(now.getTime() - 1000)
const future = new Date(now.getTime() + 1000)

describe('expireOnce', () => {
  it('expires only pending orders past their deadline and is idempotent', async () => {
    await seedOrder('aaaaaaaaaaaaaaaa', 'pending', past)
    await seedOrder('bbbbbbbbbbbbbbbb', 'pending', future)
    await seedOrder('cccccccccccccccc', 'paid', past)
    await seedOrder('dddddddddddddddd', 'cancelled', past)

    const deps = { db, now: () => now, log: pino({ level: 'silent' }) }
    expect(await expireOnce(deps)).toBe(1)
    const statuses = Object.fromEntries(
      (await db.select().from(orders)).map((o) => [o.id, o.status]),
    )
    expect(statuses).toEqual({
      aaaaaaaaaaaaaaaa: 'expired',
      bbbbbbbbbbbbbbbb: 'pending',
      cccccccccccccccc: 'paid',
      dddddddddddddddd: 'cancelled',
    })
    expect(await expireOnce(deps)).toBe(0)
  })

  it('lets a payment settle an expired order and marks it paid late', async () => {
    await seedOrder('aaaaaaaaaaaaaaaa', 'pending', past)
    await expireOnce({ db, now: () => now, log: pino({ level: 'silent' }) })

    const result = await applyPayment(
      db,
      {
        account: MERCHANT,
        txHash: '1'.repeat(64),
        txLt: 2n,
        txNow: now,
        mcBlockSeqno: 1n,
        traceId: null,
        classification: {
          kind: 'candidate',
          currency: 'TON',
          jettonMaster: null,
          amount: 1_500_000_000n,
          sender: rawAddress('11'),
          comment: 'aaaaaaaaaaaaaaaa',
          abortedNonBounceable: false,
        },
        raw: {},
      },
      { touchCursor: true, now },
    )
    expect(result).toMatchObject({ status: 'matched' })
    expect((await db.select().from(orders))[0]).toMatchObject({ status: 'paid', paidLate: true })
    // The expirer never touches a paid order afterwards.
    expect(
      await expireOnce({
        db,
        now: () => new Date(now.getTime() + 3_600_000),
        log: pino({ level: 'silent' }),
      }),
    ).toBe(0)
    expect((await db.select().from(orders))[0]?.status).toBe('paid')
  })
})
