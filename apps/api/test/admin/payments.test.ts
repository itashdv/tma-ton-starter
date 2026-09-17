import { notifications, orders, payments } from '@tma/db'
import { truncateAll } from '@tma/db/testing'
import type { AdminAttachResponse, AdminPaymentsPageDto } from '@tma/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { TestApp } from '../helpers/build-app'
import { rawAddress } from '../helpers/tx-factory'
import {
  ADMIN_ID,
  NOW,
  PAYER,
  adminApp,
  asAdmin,
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
  productId = (await seedProduct(t.handle.db)).id
})

const ORDER_ID = 'abcdefghjkmnpqrs'

function list(query = '') {
  return t.app.inject({ method: 'GET', url: `/admin/payments${query}`, headers: asAdmin() })
}

function attach(paymentId: string, body: Record<string, unknown>) {
  return t.app.inject({
    method: 'POST',
    url: `/admin/payments/${paymentId}/attach`,
    headers: asAdmin(),
    payload: body,
  })
}

async function paymentRow(id: string) {
  const [row] = await t.handle.db.select().from(payments).where(eq(payments.id, id))
  if (!row) throw new Error('payment missing')
  return row
}

async function orderRow(id: string) {
  const [row] = await t.handle.db.select().from(orders).where(eq(orders.id, id))
  if (!row) throw new Error('order missing')
  return row
}

describe('GET /admin/payments', () => {
  it('filters unmatched rows and links them to the explorer', async () => {
    const unmatched = await seedPayment(t.handle.db, {
      status: 'unmatched',
      comment: 'thanks',
      reason: 'order_not_found',
    })
    await seedPayment(t.handle.db, { status: 'matched', orderId: null })
    const response = await list('?status=unmatched')
    expect(response.statusCode).toBe(200)
    const page = response.json<AdminPaymentsPageDto>()
    expect(page.payments).toHaveLength(1)
    expect(page.payments[0]).toMatchObject({
      id: unmatched.id,
      txHash: unmatched.txHash,
      txLt: unmatched.txLt.toString(),
      senderAddress: PAYER,
      amount: '1500000000',
      currency: 'TON',
      status: 'unmatched',
      reason: 'order_not_found',
      comment: 'thanks',
      tonviewerUrl: `https://testnet.tonviewer.com/transaction/${unmatched.txHash}`,
    })
    expect(page.payments[0]?.senderUrl).toMatch(/^https:\/\/testnet\.tonviewer\.com\/0Q/)
  })

  it('shows the reason and the source wallet of ignored rows', async () => {
    await seedPayment(t.handle.db, {
      status: 'ignored',
      currency: null,
      reason: 'unsupported_asset',
      sourceWallet: rawAddress('99'),
      amount: 7_500_000n,
      comment: ORDER_ID,
    })
    const page = (await list('?status=ignored')).json<AdminPaymentsPageDto>()
    expect(page.payments).toHaveLength(1)
    expect(page.payments[0]).toMatchObject({
      status: 'ignored',
      reason: 'unsupported_asset',
      sourceWallet: rawAddress('99'),
      currency: null,
      amount: '7500000',
    })
  })

  it('pages newest first with a keyset cursor', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        (await seedPayment(t.handle.db, { createdAt: new Date(NOW.getTime() + i * 1000) })).id,
      )
    }
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = (await list(query)).json<AdminPaymentsPageDto>()
      seen.push(...page.payments.map((p) => p.id))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== null && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual([...ids].reverse())
    expect((await list('?status=nope')).statusCode).toBe(400)
  })
})

describe('POST /admin/payments/:id/attach', () => {
  it('settles an unmatched payment: matched row, paid order, one notification; a repeat is refused', async () => {
    await seedOrder(t.handle.db, { id: ORDER_ID, productId })
    const payment = await seedPayment(t.handle.db, { status: 'unmatched', comment: 'thanks' })

    const response = await attach(payment.id, { orderId: ORDER_ID })
    expect(response.statusCode).toBe(200)
    const body = response.json<AdminAttachResponse>()
    expect(body.payment).toMatchObject({
      id: payment.id,
      status: 'matched',
      orderId: ORDER_ID,
      reason: 'manual',
      attachedBy: String(ADMIN_ID),
    })
    expect(body.order).toMatchObject({ id: ORDER_ID, status: 'paid', paidAt: NOW.toISOString() })
    expect(await orderRow(ORDER_ID)).toMatchObject({ status: 'paid', paidLate: false })
    const queued = await t.handle.db.select().from(notifications)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ orderId: ORDER_ID, status: 'pending' })

    const again = await attach(payment.id, { orderId: ORDER_ID })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: { code: 'payment_not_attachable' } })
  })

  it('accepts whitespace and capitals around the order id', async () => {
    await seedOrder(t.handle.db, { id: ORDER_ID, productId })
    const payment = await seedPayment(t.handle.db, { status: 'unmatched' })
    expect((await attach(payment.id, { orderId: `  ${ORDER_ID.toUpperCase()} ` })).statusCode).toBe(
      200,
    )
    expect((await orderRow(ORDER_ID)).status).toBe('paid')
  })

  it('refuses an underpayment unless forced, and never changes the row on refusal', async () => {
    await seedOrder(t.handle.db, { id: ORDER_ID, productId, amount: 1_500_000_000n })
    const payment = await seedPayment(t.handle.db, {
      status: 'underpaid',
      amount: 1_000_000_000n,
      orderId: ORDER_ID,
      comment: ORDER_ID,
    })

    const refused = await attach(payment.id, { orderId: ORDER_ID })
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({ error: { code: 'underpaid' } })
    expect(await paymentRow(payment.id)).toMatchObject({
      status: 'underpaid',
      orderId: ORDER_ID,
      reason: null,
    })
    expect((await orderRow(ORDER_ID)).status).toBe('pending')
    expect(await t.handle.db.select().from(notifications)).toHaveLength(0)

    const forced = await attach(payment.id, { orderId: ORDER_ID, force: true })
    expect(forced.statusCode).toBe(200)
    expect(forced.json<AdminAttachResponse>().payment).toMatchObject({
      status: 'matched',
      reason: 'manual',
    })
    expect((await orderRow(ORDER_ID)).status).toBe('paid')
    expect(await t.handle.db.select().from(notifications)).toHaveLength(1)
  })

  it('never attaches a foreign asset, even with force', async () => {
    await seedOrder(t.handle.db, { id: ORDER_ID, productId, currency: 'TON', amount: 1_000_000n })
    const usdt = await seedPayment(t.handle.db, {
      status: 'unmatched',
      currency: 'USDT',
      amount: 1_000_000n,
    })
    for (const force of [false, true]) {
      const response = await attach(usdt.id, { orderId: ORDER_ID, force })
      expect(response.statusCode).toBe(422)
      expect(response.json()).toMatchObject({ error: { code: 'currency_mismatch' } })
    }
    expect(await paymentRow(usdt.id)).toMatchObject({ status: 'unmatched', orderId: null })
    expect((await orderRow(ORDER_ID)).status).toBe('pending')
  })

  it('refuses matched and ignored rows', async () => {
    await seedOrder(t.handle.db, { id: ORDER_ID, productId })
    const matched = await seedPayment(t.handle.db, { status: 'matched' })
    const ignored = await seedPayment(t.handle.db, {
      status: 'ignored',
      currency: null,
      reason: 'unsupported_asset',
    })
    for (const id of [matched.id, ignored.id]) {
      const response = await attach(id, { orderId: ORDER_ID })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: { code: 'payment_not_attachable' } })
    }
    expect((await orderRow(ORDER_ID)).status).toBe('pending')
  })

  it('refuses paid and cancelled orders and reports unknown ids', async () => {
    await seedOrder(t.handle.db, { id: ORDER_ID, productId, status: 'paid', paidAt: NOW })
    await seedOrder(t.handle.db, { id: 'kkkkkkkkkkkkkkkk', productId, status: 'cancelled' })
    const payment = await seedPayment(t.handle.db, { status: 'unmatched' })

    const paid = await attach(payment.id, { orderId: ORDER_ID })
    expect(paid.statusCode).toBe(409)
    expect(paid.json()).toMatchObject({ error: { code: 'order_already_paid' } })
    const cancelled = await attach(payment.id, { orderId: 'kkkkkkkkkkkkkkkk' })
    expect(cancelled.statusCode).toBe(409)
    expect(cancelled.json()).toMatchObject({ error: { code: 'order_cancelled' } })
    expect((await attach(payment.id, { orderId: 'zzzzzzzzzzzzzzzz' })).statusCode).toBe(404)
    expect((await attach(payment.id, { orderId: 'short' })).statusCode).toBe(400)
    expect(
      (await attach('00000000-0000-4000-8000-000000000000', { orderId: ORDER_ID })).statusCode,
    ).toBe(404)
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'unmatched', orderId: null })
  })

  it('pays an expired order late and flags it', async () => {
    await seedOrder(t.handle.db, {
      id: ORDER_ID,
      productId,
      status: 'expired',
      expiresAt: new Date(NOW.getTime() - 60_000),
    })
    const payment = await seedPayment(t.handle.db, { status: 'unmatched' })
    expect((await attach(payment.id, { orderId: ORDER_ID })).statusCode).toBe(200)
    expect(await orderRow(ORDER_ID)).toMatchObject({ status: 'paid', paidLate: true })
  })
})

describe('review follow-ups: payments', () => {
  it('attaches a USDT payment to a USDT order of the same master', async () => {
    await seedOrder(t.handle.db, { id: ORDER_ID, productId, currency: 'USDT', amount: 5_000_000n })
    const payment = await seedPayment(t.handle.db, { status: 'unmatched', currency: 'USDT' })
    const response = await attach(payment.id, { orderId: ORDER_ID })
    expect(response.statusCode).toBe(200)
    expect(response.json<AdminAttachResponse>().payment).toMatchObject({
      status: 'matched',
      currency: 'USDT',
      orderId: ORDER_ID,
    })
    expect((await orderRow(ORDER_ID)).status).toBe('paid')
  })

  it('rejects forged cursors before they reach the database', async () => {
    await seedPayment(t.handle.db)
    const forged = (cursor: object) => Buffer.from(JSON.stringify(cursor)).toString('base64url')
    for (const cursor of [
      { t: '1789560000000000', id: 'x' },
      { t: '2026-13-45 25:61:61+00', id: '00000000-0000-4000-8000-000000000000' },
      { t: '-1', id: '00000000-0000-4000-8000-000000000000' },
      { t: '1789560000000000', id: '00000000-0000-4000-8000-000000000000', extra: 1 },
    ]) {
      const response = await list(`?cursor=${encodeURIComponent(forged(cursor))}`)
      expect(response.statusCode, JSON.stringify(cursor)).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'invalid_cursor' } })
    }
  })
})
