import { Address, beginCell, storeMessage } from '@ton/core'
import { orders, users } from '@tma/db'
import { truncateAll } from '@tma/db/testing'
import type { CreateOrderResponse, OrderDto } from '@tma/shared'
import {
  cellFromBase64,
  normalizedExternalMessageHash,
  parseJettonTransferBody,
  parseTextComment,
} from '@tma/shared/ton'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { expireOrdersOnce } from '../src/services/orders'
import { buildTestApp, testEnv, type TestApp } from './helpers/build-app'
import { authHeader, seedProduct } from './helpers/auth'
import {
  fakeJettonWalletFor,
  startFakeToncenter,
  type FakeToncenter,
} from './helpers/fake-toncenter'

const USER_ID = 42
const OTHER_USER_ID = 43
const now = new Date('2026-09-16T12:00:00Z')
const nowSec = Math.floor(now.getTime() / 1000)
const PAYER = Address.parseRaw(`0:${'11'.repeat(32)}`).toString({
  testOnly: true,
  bounceable: false,
})
const OTHER_PAYER = Address.parseRaw(`0:${'55'.repeat(32)}`).toString({
  testOnly: true,
  bounceable: false,
})
/** What the fake jetton master answers for PAYER. */
const PAYER_JETTON_WALLET = fakeJettonWalletFor(Address.parse(PAYER))

let t: TestApp
let fake: FakeToncenter

beforeAll(async () => {
  fake = await startFakeToncenter()
  t = buildTestApp({ now: () => now, toncenterUrl: fake.url })
  await t.app.ready()
})

afterAll(async () => {
  await t.close()
  await fake.close()
})

beforeEach(async () => {
  await truncateAll(t.handle.db)
  fake.requests.length = 0
  fake.setJettonWallet(PAYER_JETTON_WALLET)
  // The resolver caches for the process lifetime; each test starts from a cold cache.
  t.app.deps.jettonWallets.clear()
})

function createOrder(body: Record<string, unknown>, options: { id?: number } = {}) {
  return t.app.inject({
    method: 'POST',
    url: '/orders',
    headers: { authorization: authHeader({ id: options.id ?? USER_ID, authDate: nowSec }) },
    payload: body,
  })
}

describe('POST /orders (TON)', () => {
  it('snapshots the price from the database and builds a non-bounceable transfer', async () => {
    const product = await seedProduct(t.handle.db, { priceTonNano: 1_500_000_000n })
    const response = await createOrder({
      productId: product.id,
      currency: 'TON',
      walletAddress: PAYER,
      amount: '1',
    })
    expect(response.statusCode).toBe(201)

    const { order, payment } = response.json<CreateOrderResponse>()
    expect(order.status).toBe('pending')
    expect(order.currency).toBe('TON')
    expect(order.amount).toBe('1500000000') // the client's "amount: 1" is ignored
    expect(order.productTitle).toBe(product.title)
    expect(order.expiresAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString())
    expect(order.delivery).toBeNull()

    expect(payment.network).toBe('-3')
    expect(payment.comment).toBe(order.id)
    expect(payment.jettonMaster).toBeNull()
    expect(payment.validSeconds).toBe(300)
    expect(payment.messages).toHaveLength(1)
    const [message] = payment.messages
    expect(message?.address.startsWith('0Q')).toBe(true) // non-bounceable, testnet
    expect(message?.amount).toBe('1500000000')
    expect(parseTextComment(cellFromBase64(message?.payload ?? ''))).toBe(order.id)

    const [row] = await t.handle.db.select().from(orders).where(eq(orders.id, order.id))
    expect(row?.payerAddress).toBe(`0:${'11'.repeat(64 / 2)}`)
    expect(row?.merchantAddress).toBe(testEnv().merchantRaw)
    expect(row?.jettonMaster).toBeNull()
    expect(fake.requests).toHaveLength(0) // a TON payment needs no toncenter call
  })

  it('creates the user row so the order can reference it', async () => {
    const product = await seedProduct(t.handle.db)
    await createOrder({ productId: product.id, currency: 'TON', walletAddress: PAYER })
    const [user] = await t.handle.db
      .select()
      .from(users)
      .where(eq(users.telegramId, BigInt(USER_ID)))
    expect(user).toBeDefined()
  })
})

describe('POST /orders (USDT)', () => {
  it('addresses the payer jetton wallet and carries the order id in the forward payload', async () => {
    const product = await seedProduct(t.handle.db, { priceUsdtUnits: 5_000_000n })
    const response = await createOrder({
      productId: product.id,
      currency: 'USDT',
      walletAddress: PAYER,
    })
    expect(response.statusCode).toBe(201)
    const { order, payment } = response.json<CreateOrderResponse>()

    expect(order.amount).toBe('5000000')
    expect(payment.jettonMaster).toBe(testEnv().usdtMaster?.address.toRawString())
    const [message] = payment.messages
    expect(message?.address.startsWith('kQ')).toBe(true) // bounceable contract, testnet
    expect(Address.parse(message?.address ?? '').equals(PAYER_JETTON_WALLET)).toBe(true)
    expect(message?.amount).toBe('50000000') // TON attached for gas, not the jetton amount

    const body = parseJettonTransferBody(cellFromBase64(message?.payload ?? ''))
    expect(body?.amount).toBe(5_000_000n)
    expect(body?.destination.equals(testEnv().merchant.address)).toBe(true)
    expect(body?.responseDestination?.equals(Address.parse(PAYER))).toBe(true)
    expect(body?.forwardTonAmount).toBe(1n)
    expect(body?.comment).toBe(order.id)

    const [row] = await t.handle.db.select().from(orders).where(eq(orders.id, order.id))
    expect(row?.jettonMaster).toBe(testEnv().usdtMaster?.raw)
    expect(row?.payerJettonWallet).toBe(
      `${PAYER_JETTON_WALLET.workChain}:${PAYER_JETTON_WALLET.hash.toString('hex').toUpperCase()}`,
    )
  })

  it('caches the jetton wallet per payer, not per jetton', async () => {
    const product = await seedProduct(t.handle.db)
    const first = (
      await createOrder({ productId: product.id, currency: 'USDT', walletAddress: PAYER })
    ).json<CreateOrderResponse>()
    const cached = (
      await createOrder({ productId: product.id, currency: 'USDT', walletAddress: PAYER })
    ).json<CreateOrderResponse>()
    expect(fake.requests.filter((r) => r.path === '/runGetMethod')).toHaveLength(1)
    expect(cached.payment.messages[0]?.address).toBe(first.payment.messages[0]?.address)

    // A different payer must be resolved separately, or their transfer would be addressed to
    // somebody else's jetton wallet.
    const other = (
      await createOrder(
        { productId: product.id, currency: 'USDT', walletAddress: OTHER_PAYER },
        { id: OTHER_USER_ID },
      )
    ).json<CreateOrderResponse>()
    expect(fake.requests.filter((r) => r.path === '/runGetMethod')).toHaveLength(2)
    expect(other.payment.messages[0]?.address).not.toBe(first.payment.messages[0]?.address)
    expect(
      Address.parse(other.payment.messages[0]?.address ?? '').equals(
        fakeJettonWalletFor(Address.parse(OTHER_PAYER)),
      ),
    ).toBe(true)
  })

  it('answers 502 without creating an order when toncenter is down', async () => {
    const product = await seedProduct(t.handle.db)
    fake.enqueue('/runGetMethod', { kind: 'status', status: 500 })
    fake.enqueue('/runGetMethod', { kind: 'status', status: 500 })
    const response = await createOrder({
      productId: product.id,
      currency: 'USDT',
      walletAddress: PAYER,
    })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ error: { code: 'toncenter_unavailable' } })
    expect(await t.handle.db.select().from(orders)).toHaveLength(0)
  })

  it('answers 502 when toncenter hangs instead of waiting forever', async () => {
    const product = await seedProduct(t.handle.db)
    fake.enqueue('/runGetMethod', { kind: 'hang' })
    fake.enqueue('/runGetMethod', { kind: 'hang' })
    // A short injected timeout keeps the test fast and deterministic on a loaded host; the
    // request policy itself is covered in toncenter.test.ts.
    const fast = buildTestApp(
      { now: () => now, toncenterUrl: fake.url, toncenterTimeoutMs: 50 },
      t.handle,
    )
    await fast.app.ready()
    try {
      const response = await fast.app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: authHeader({ id: USER_ID, authDate: nowSec }) },
        payload: { productId: product.id, currency: 'USDT', walletAddress: PAYER },
      })
      expect(response.statusCode).toBe(502)
      expect(response.json()).toMatchObject({ error: { code: 'toncenter_unavailable' } })
    } finally {
      await fast.app.close()
    }
  })
})

describe('POST /orders validation', () => {
  it('rejects a currency the product has no price for', async () => {
    const product = await seedProduct(t.handle.db, { priceUsdtUnits: null })
    const response = await createOrder({
      productId: product.id,
      currency: 'USDT',
      walletAddress: PAYER,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'currency_unavailable' } })
  })

  it('rejects an inactive or unknown product', async () => {
    const hidden = await seedProduct(t.handle.db, { slug: 'hidden', isActive: false })
    expect(
      (await createOrder({ productId: hidden.id, currency: 'TON', walletAddress: PAYER }))
        .statusCode,
    ).toBe(404)
    const unknown = await createOrder({
      productId: '00000000-0000-4000-8000-000000000000',
      currency: 'TON',
      walletAddress: PAYER,
    })
    expect(unknown.statusCode).toBe(404)
  })

  it('rejects a malformed wallet address and a malformed body', async () => {
    const product = await seedProduct(t.handle.db)
    const bad = await createOrder({ productId: product.id, currency: 'TON', walletAddress: 'nope' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_address' } })
    const malformed = await createOrder({
      productId: 'not-a-uuid',
      currency: 'TON',
      walletAddress: PAYER,
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({ error: { code: 'validation_error' } })
    const wrongCurrency = await createOrder({
      productId: product.id,
      currency: 'EUR',
      walletAddress: PAYER,
    })
    expect(wrongCurrency.statusCode).toBe(400)
  })

  it('requires authentication', async () => {
    const product = await seedProduct(t.handle.db)
    const response = await t.app.inject({
      method: 'POST',
      url: '/orders',
      payload: { productId: product.id, currency: 'TON', walletAddress: PAYER },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('open order limit', () => {
  it('allows five open orders and rejects the sixth, ignoring expired ones', async () => {
    const product = await seedProduct(t.handle.db)
    for (let i = 0; i < 5; i += 1) {
      const response = await createOrder({
        productId: product.id,
        currency: 'TON',
        walletAddress: PAYER,
      })
      expect(response.statusCode).toBe(201)
    }
    const sixth = await createOrder({
      productId: product.id,
      currency: 'TON',
      walletAddress: PAYER,
    })
    expect(sixth.statusCode).toBe(409)
    expect(sixth.json()).toMatchObject({ error: { code: 'order_limit' } })

    // An order past its deadline no longer counts, even before the worker expires it.
    const [oldest] = await t.handle.db.select().from(orders).limit(1)
    await t.handle.db
      .update(orders)
      .set({ expiresAt: new Date(now.getTime() - 1000) })
      .where(eq(orders.id, oldest?.id ?? ''))
    expect(
      (await createOrder({ productId: product.id, currency: 'TON', walletAddress: PAYER }))
        .statusCode,
    ).toBe(201)
  })

  it('counts per user', async () => {
    const product = await seedProduct(t.handle.db)
    for (let i = 0; i < 5; i += 1)
      await createOrder({ productId: product.id, currency: 'TON', walletAddress: PAYER })
    const other = await createOrder(
      { productId: product.id, currency: 'TON', walletAddress: PAYER },
      { id: OTHER_USER_ID },
    )
    expect(other.statusCode).toBe(201)
  })
})

describe('reading orders', () => {
  async function anOrder() {
    const product = await seedProduct(t.handle.db, {
      deliveryPayload: 'SECRET-CODE',
      deliverInChat: true,
    })
    const response = await createOrder({
      productId: product.id,
      currency: 'TON',
      walletAddress: PAYER,
    })
    return response.json<CreateOrderResponse>().order
  }

  it('lists only the caller orders, newest first', async () => {
    const mine = await anOrder()
    await createOrder(
      {
        productId: (await seedProduct(t.handle.db, { slug: 'other' })).id,
        currency: 'TON',
        walletAddress: PAYER,
      },
      { id: OTHER_USER_ID },
    )
    const response = await t.app.inject({
      method: 'GET',
      url: '/orders',
      headers: { authorization: authHeader({ id: USER_ID, authDate: nowSec }) },
    })
    const { orders: list } = response.json<{ orders: OrderDto[] }>()
    expect(list.map((o) => o.id)).toEqual([mine.id])
  })

  it('hides another user order behind a 404', async () => {
    const order = await anOrder()
    const response = await t.app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: { authorization: authHeader({ id: OTHER_USER_ID, authDate: nowSec }) },
    })
    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain(order.id)
  })

  it('reveals the delivery payload only after the order is paid', async () => {
    const order = await anOrder()
    const read = async () => {
      const response = await t.app.inject({
        method: 'GET',
        url: `/orders/${order.id}`,
        headers: { authorization: authHeader({ id: USER_ID, authDate: nowSec }) },
      })
      return response.json<{ order: OrderDto }>().order
    }
    expect((await read()).delivery).toBeNull()

    await t.handle.db
      .update(orders)
      .set({ status: 'paid', paidAt: now })
      .where(eq(orders.id, order.id))
    const paid = await read()
    expect(paid.status).toBe('paid')
    expect(paid.delivery).toEqual({ payload: 'SECRET-CODE', deliverInChat: true })
  })
})

describe('POST /orders/:id/submitted', () => {
  async function anOrder() {
    const product = await seedProduct(t.handle.db)
    const response = await createOrder({
      productId: product.id,
      currency: 'TON',
      walletAddress: PAYER,
    })
    return response.json<CreateOrderResponse>()
  }

  /** A signed external message as a wallet would return it from sendTransaction. */
  const BOC = beginCell()
    .store(
      storeMessage({
        info: {
          type: 'external-in',
          src: null,
          dest: Address.parseRaw(`0:${'11'.repeat(32)}`),
          importFee: 0n,
        },
        body: beginCell().storeUint(0x706c7567, 32).endCell(),
      }),
    )
    .endCell()
    .toBoc()
    .toString('base64')

  it('stores the normalized external message hash and is idempotent', async () => {
    const { order } = await anOrder()
    const submit = (boc: string) =>
      t.app.inject({
        method: 'POST',
        url: `/orders/${order.id}/submitted`,
        headers: { authorization: authHeader({ id: USER_ID, authDate: nowSec }) },
        payload: { boc },
      })

    const first = await submit(BOC)
    expect(first.statusCode).toBe(200)
    expect(first.json<{ order: OrderDto }>().order.submittedAt).toBe(now.toISOString())

    const [row] = await t.handle.db.select().from(orders).where(eq(orders.id, order.id))
    expect(row?.extMsgHash).toBe(normalizedExternalMessageHash(BOC))

    const second = await submit(BOC)
    expect(second.statusCode).toBe(200)
    const [after] = await t.handle.db.select().from(orders).where(eq(orders.id, order.id))
    expect(after?.extMsgHash).toBe(row?.extMsgHash)
  })

  it('rejects a boc that is not an external message and another user order', async () => {
    const { order } = await anOrder()
    const invalid = await t.app.inject({
      method: 'POST',
      url: `/orders/${order.id}/submitted`,
      headers: { authorization: authHeader({ id: USER_ID, authDate: nowSec }) },
      payload: { boc: 'not-a-boc' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ error: { code: 'invalid_boc' } })

    const foreign = await t.app.inject({
      method: 'POST',
      url: `/orders/${order.id}/submitted`,
      headers: { authorization: authHeader({ id: OTHER_USER_ID, authDate: nowSec }) },
      payload: { boc: BOC },
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('does not confirm the order: only the chain can do that', async () => {
    const { order } = await anOrder()
    await t.app.inject({
      method: 'POST',
      url: `/orders/${order.id}/submitted`,
      headers: { authorization: authHeader({ id: USER_ID, authDate: nowSec }) },
      payload: { boc: BOC },
    })
    const [row] = await t.handle.db.select().from(orders).where(eq(orders.id, order.id))
    expect(row?.status).toBe('pending')
    expect(row?.paidAt).toBeNull()
  })
})

describe('expireOrdersOnce', () => {
  it('expires only pending orders past their deadline', async () => {
    const product = await seedProduct(t.handle.db)
    const pending = (
      await createOrder({ productId: product.id, currency: 'TON', walletAddress: PAYER })
    ).json<CreateOrderResponse>().order
    const paid = (
      await createOrder({ productId: product.id, currency: 'TON', walletAddress: PAYER })
    ).json<CreateOrderResponse>().order
    await t.handle.db.update(orders).set({ status: 'paid' }).where(eq(orders.id, paid.id))

    const later = new Date(now.getTime() + 31 * 60_000)
    expect(await expireOrdersOnce(t.handle.db, later)).toBe(1)
    const rows = await t.handle.db.select().from(orders)
    expect(rows.find((r) => r.id === pending.id)?.status).toBe('expired')
    expect(rows.find((r) => r.id === paid.id)?.status).toBe('paid')
    expect(await expireOrdersOnce(t.handle.db, later)).toBe(0) // idempotent
  })
})
