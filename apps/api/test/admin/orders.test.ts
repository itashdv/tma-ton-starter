import { notifications, orders, products } from '@tma/db'
import { truncateAll } from '@tma/db/testing'
import type {
  AdminNotificationDto,
  AdminOrderDetailsDto,
  AdminOrderDto,
  AdminOrdersPageDto,
} from '@tma/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { TestApp } from '../helpers/build-app'
import {
  ADMIN_ID,
  MERCHANT,
  NOW,
  USER_ID,
  adminApp,
  asAdmin,
  seedNotification,
  seedOrder,
  seedPayment,
  seedProduct,
  seedUser,
} from './helpers'

let t: TestApp
let productId: string

beforeAll(async () => {
  t = adminApp()
  await t.app.ready()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await truncateAll(t.handle.db)
  await seedUser(t.handle.db)
  productId = (await seedProduct(t.handle.db, { deliveryPayload: 'CODE-1' })).id
})

const ID = (letter: string) => letter.repeat(16)

function list(query = '') {
  return t.app.inject({ method: 'GET', url: `/admin/orders${query}`, headers: asAdmin() })
}

describe('GET /admin/orders', () => {
  it('pages with a keyset over five orders created in the same millisecond', async () => {
    for (const letter of ['a', 'b', 'c', 'd', 'e']) {
      await seedOrder(t.handle.db, { id: ID(letter), productId, createdAt: NOW })
    }
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const response = await list(query)
      expect(response.statusCode).toBe(200)
      const page = response.json<AdminOrdersPageDto>()
      expect(page.orders.length).toBeLessThanOrEqual(2)
      seen.push(...page.orders.map((o) => o.id))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== null && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual([ID('e'), ID('d'), ID('c'), ID('b'), ID('a')])
    expect(new Set(seen).size).toBe(5)
  })

  it('orders by creation time first, newest first, and exposes admin fields', async () => {
    await seedOrder(t.handle.db, {
      id: ID('a'),
      productId,
      createdAt: new Date(NOW.getTime() - 5000),
    })
    await seedOrder(t.handle.db, {
      id: ID('z'),
      productId,
      createdAt: new Date(NOW.getTime() - 9000),
    })
    await seedOrder(t.handle.db, { id: ID('m'), productId, createdAt: NOW })
    const page = (await list()).json<AdminOrdersPageDto>()
    expect(page.orders.map((o) => o.id)).toEqual([ID('m'), ID('a'), ID('z')])
    expect(page.nextCursor).toBeNull()
    expect(page.orders[0]).toMatchObject({
      userId: '42',
      userUsername: 'tester',
      userFirstName: 'Test',
      merchantAddress: expect.stringMatching(/^0:AA/),
      payerAddress: expect.stringMatching(/^0:11/),
      cancelledAt: null,
      delivery: null,
    })
  })

  it('filters by status and rejects unknown statuses and cursors', async () => {
    await seedOrder(t.handle.db, { id: ID('a'), productId, status: 'paid', paidAt: NOW })
    await seedOrder(t.handle.db, { id: ID('b'), productId, status: 'pending' })
    const paid = (await list('?status=paid')).json<AdminOrdersPageDto>()
    expect(paid.orders.map((o) => o.id)).toEqual([ID('a')])
    expect((await list('?status=bogus')).statusCode).toBe(400)
    const badCursor = await list('?cursor=not-a-cursor')
    expect(badCursor.statusCode).toBe(400)
    expect(badCursor.json()).toMatchObject({ error: { code: 'invalid_cursor' } })
    expect((await list('?limit=0')).statusCode).toBe(400)
  })
})

describe('GET /admin/orders/:id', () => {
  it('returns the order with its payments and notifications', async () => {
    const order = await seedOrder(t.handle.db, {
      id: ID('a'),
      productId,
      status: 'paid',
      paidAt: NOW,
    })
    await seedPayment(t.handle.db, { status: 'matched', orderId: order.id, comment: order.id })
    await seedPayment(t.handle.db, { status: 'unmatched', comment: 'x' })
    await seedNotification(t.handle.db, order.id, { status: 'sent', attempts: 1 })

    const response = await t.app.inject({
      method: 'GET',
      url: `/admin/orders/${order.id}`,
      headers: asAdmin(),
    })
    expect(response.statusCode).toBe(200)
    const details = response.json<AdminOrderDetailsDto>()
    expect(details.order).toMatchObject({ id: order.id, status: 'paid' })
    expect(details.order.delivery).toEqual({ payload: 'CODE-1', deliverInChat: false })
    expect(details.payments).toHaveLength(1)
    expect(details.payments[0]).toMatchObject({
      status: 'matched',
      orderId: order.id,
      amount: '1500000000',
      tonviewerUrl: expect.stringContaining('/transaction/'),
    })
    expect(details.notifications).toHaveLength(1)
    expect(details.notifications[0]).toMatchObject({
      status: 'sent',
      attempts: 1,
      telegramUserId: '42',
    })
  })

  it('answers 404 for an unknown order', async () => {
    const response = await t.app.inject({
      method: 'GET',
      url: `/admin/orders/${ID('q')}`,
      headers: asAdmin(),
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('POST /admin/orders/:id/cancel', () => {
  function cancel(id: string, body: Record<string, unknown> = {}) {
    return t.app.inject({
      method: 'POST',
      url: `/admin/orders/${id}/cancel`,
      headers: asAdmin(),
      payload: body,
    })
  }

  it('cancels pending and expired orders and records who did it', async () => {
    await seedOrder(t.handle.db, { id: ID('a'), productId, status: 'pending' })
    await seedOrder(t.handle.db, { id: ID('b'), productId, status: 'expired' })

    const response = await cancel(ID('a'), { note: 'customer asked' })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ order: AdminOrderDto }>().order).toMatchObject({
      status: 'cancelled',
      cancelledBy: String(ADMIN_ID),
      cancelledAt: NOW.toISOString(),
      adminNote: 'customer asked',
    })
    expect((await cancel(ID('b'))).statusCode).toBe(200)
    const rows = await t.handle.db.select().from(orders)
    expect(rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled'])
    expect(rows.find((r) => r.id === ID('a'))?.cancelledBy).toBe(BigInt(ADMIN_ID))
  })

  it('refuses paid and already cancelled orders, and unknown ids', async () => {
    await seedOrder(t.handle.db, { id: ID('a'), productId, status: 'paid', paidAt: NOW })
    await seedOrder(t.handle.db, { id: ID('b'), productId, status: 'cancelled' })
    const paid = await cancel(ID('a'))
    expect(paid.statusCode).toBe(409)
    expect(paid.json()).toMatchObject({ error: { code: 'order_not_cancellable' } })
    expect((await cancel(ID('b'))).statusCode).toBe(409)
    expect((await cancel(ID('q'))).statusCode).toBe(404)
    expect((await t.handle.db.select().from(orders)).find((r) => r.id === ID('a'))?.status).toBe(
      'paid',
    )
  })
})

describe('POST /admin/orders/:id/resend-notification', () => {
  function resend(id: string) {
    return t.app.inject({
      method: 'POST',
      url: `/admin/orders/${id}/resend-notification`,
      headers: asAdmin(),
      payload: {},
    })
  }

  it('puts the outbox row of a paid order back to pending with a fresh attempt budget', async () => {
    const order = await seedOrder(t.handle.db, {
      id: ID('a'),
      productId,
      status: 'paid',
      paidAt: NOW,
    })
    const existing = await seedNotification(t.handle.db, order.id, {
      status: 'failed',
      attempts: 8,
      lastError: 'Forbidden',
    })
    const response = await resend(order.id)
    expect(response.statusCode).toBe(200)
    const { notification } = response.json<{ notification: AdminNotificationDto }>()
    expect(notification).toMatchObject({
      id: existing.id,
      status: 'pending',
      attempts: 0,
      lastError: null,
      sentAt: null,
      nextAttemptAt: NOW.toISOString(),
    })
    const [row] = await t.handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, existing.id))
    expect(row).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null })
  })

  it('creates the row when a paid order somehow has none', async () => {
    const order = await seedOrder(t.handle.db, {
      id: ID('a'),
      productId,
      status: 'paid',
      paidAt: NOW,
    })
    expect((await resend(order.id)).statusCode).toBe(200)
    expect(await t.handle.db.select().from(notifications)).toHaveLength(1)
  })

  it('refuses orders that are not paid', async () => {
    await seedOrder(t.handle.db, { id: ID('a'), productId, status: 'pending' })
    const response = await resend(ID('a'))
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'order_not_paid' } })
    expect((await resend(ID('q'))).statusCode).toBe(404)
  })
})

describe('review follow-ups: orders', () => {
  it('pages correctly across rows one microsecond apart, which a JavaScript Date cannot tell apart', async () => {
    const [product] = await t.handle.db.select().from(products).limit(1)
    if (!product) throw new Error('product missing')
    for (const [letter, micros] of [
      ['a', '000001'],
      ['b', '000002'],
      ['c', '000003'],
    ] as const) {
      await t.handle.db.execute(sql`
        INSERT INTO orders (id, user_id, product_id, product_title, currency, amount, merchant_address,
                            status, expires_at, created_at, updated_at)
        VALUES (${ID(letter)}, ${USER_ID}, ${product.id}, 'Guide', 'TON', 1500000000, ${MERCHANT},
                'pending', '2026-09-16 12:30:00+00',
                ${`2026-09-16 12:00:00.${micros}+00`}::timestamptz, now())
      `)
    }
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = (await list(query)).json<AdminOrdersPageDto>()
      seen.push(...page.orders.map((o) => o.id))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== null && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual([ID('c'), ID('b'), ID('a')])
  })

  it('rejects a cursor whose id is not an order id or whose timestamp is not an integer', async () => {
    await seedOrder(t.handle.db, { id: ID('a'), productId })
    const forged = (cursor: object) => Buffer.from(JSON.stringify(cursor)).toString('base64url')
    for (const cursor of [
      { t: '1789560000000000', id: 'not-an-order-id' },
      { t: '2026-09-16 12:00:00+00', id: ID('a') },
      { t: '1789560000000000', id: ID('a').toUpperCase() },
    ]) {
      const response = await list(`?cursor=${encodeURIComponent(forged(cursor))}`)
      expect(response.statusCode, JSON.stringify(cursor)).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'invalid_cursor' } })
    }
  })

  it('refuses to resend while the notifier is sending, and allows it once the claim went stale', async () => {
    const order = await seedOrder(t.handle.db, {
      id: ID('a'),
      productId,
      status: 'paid',
      paidAt: NOW,
    })
    const inFlight = await seedNotification(t.handle.db, order.id, {
      status: 'pending',
      attempts: 1,
      claimedAt: new Date(NOW.getTime() - 60_000),
    })
    const refused = await t.app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/resend-notification`,
      headers: asAdmin(),
      payload: {},
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ error: { code: 'notification_in_flight' } })
    const [untouched] = await t.handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, inFlight.id))
    expect(untouched).toMatchObject({ attempts: 1, claimedAt: new Date(NOW.getTime() - 60_000) })

    await t.handle.db
      .update(notifications)
      .set({ claimedAt: new Date(NOW.getTime() - 6 * 60_000) })
      .where(eq(notifications.id, inFlight.id))
    const allowed = await t.app.inject({
      method: 'POST',
      url: `/admin/orders/${order.id}/resend-notification`,
      headers: asAdmin(),
      payload: {},
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json<{ notification: AdminNotificationDto }>().notification).toMatchObject({
      attempts: 0,
      claimedAt: null,
    })
  })
})
