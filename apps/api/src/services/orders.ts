import type { Address } from '@ton/core'
import { PG_UNIQUE_VIOLATION, orders, pgErrorCode, products, type Db } from '@tma/db'
import {
  generateOrderId,
  type CreateOrderResponse,
  type OrderCurrency,
  type OrderDto,
} from '@tma/shared'
import { normalizedExternalMessageHash } from '@tma/shared/ton'
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm'

import type { LoadedShopConfig } from '../config/shop'
import type { Env } from '../env'
import { ApiError } from '../errors'
import { parseAddress, toRawAddress } from '../ton/address'
import type { JettonWalletResolver } from '../ton/jetton-wallet'
import { ToncenterError } from '../ton/toncenter'
import { buildPaymentInstructions } from './payment-instructions'

export interface OrderServiceDeps {
  db: Db
  env: Env
  shop: LoadedShopConfig
  jettonWallets: JettonWalletResolver
  now: () => Date
  newOrderId: () => string
  /** Random 64-bit query id for jetton transfers; injectable for deterministic tests. */
  newQueryId: () => bigint
}

export interface CreateOrderInput {
  userId: number
  productId: string
  currency: OrderCurrency
  walletAddress: string
}

type OrderRow = typeof orders.$inferSelect

export interface DeliveryInfo {
  payload: string | null
  deliverInChat: boolean
}

export function toOrderDto(order: OrderRow, delivery?: DeliveryInfo | null): OrderDto {
  return {
    id: order.id,
    status: order.status,
    currency: order.currency,
    amount: order.amount.toString(),
    productId: order.productId,
    productTitle: order.productTitle,
    createdAt: order.createdAt.toISOString(),
    expiresAt: order.expiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    paidLate: order.paidLate,
    submittedAt: order.submittedAt?.toISOString() ?? null,
    // The digital good is revealed only after the chain confirmed the payment.
    delivery:
      order.status === 'paid' ? (delivery ?? { payload: null, deliverInChat: false }) : null,
  }
}

export async function createOrder(
  deps: OrderServiceDeps,
  input: CreateOrderInput,
): Promise<CreateOrderResponse> {
  const { db, env, shop } = deps
  if (!shop.shop.currencies.includes(input.currency)) {
    throw new ApiError(
      400,
      'currency_unavailable',
      `${input.currency} is not accepted by this shop`,
    )
  }

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.isActive, true)))
    .limit(1)
  if (!product) throw new ApiError(404, 'not_found', 'product not found')

  // The amount always comes from the database, never from the client.
  const amount = input.currency === 'TON' ? product.priceTonNano : product.priceUsdtUnits
  if (amount === null || amount <= 0n) {
    throw new ApiError(400, 'currency_unavailable', `this product has no ${input.currency} price`)
  }

  let payer: Address
  try {
    payer = parseAddress(input.walletAddress).address
  } catch {
    throw new ApiError(400, 'invalid_address', 'walletAddress is not a TON address')
  }

  const now = deps.now()
  // Spam guard, not an invariant: two concurrent requests can both pass this check. Exceeding
  // the limit by one costs nothing (an unpaid order simply expires), so it does not justify an
  // exclusive lock on the request path.
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.userId, BigInt(input.userId)),
        eq(orders.status, 'pending'),
        gt(orders.expiresAt, now),
      ),
    )
  if ((open?.n ?? 0) >= env.MAX_PENDING_ORDERS_PER_USER) {
    throw new ApiError(409, 'order_limit', 'too many unpaid orders, pay or wait for them to expire')
  }

  let payerJettonWallet: Address | null = null
  const jettonMaster = env.usdtMaster?.address ?? null
  if (input.currency === 'USDT') {
    if (!jettonMaster) {
      throw new ApiError(400, 'currency_unavailable', 'no jetton master is configured')
    }
    try {
      payerJettonWallet = await deps.jettonWallets.resolve(jettonMaster, payer)
    } catch (error) {
      if (error instanceof ToncenterError) {
        throw new ApiError(
          502,
          'toncenter_unavailable',
          'cannot resolve the jetton wallet right now',
        )
      }
      throw error
    }
  }

  const expiresAt = new Date(now.getTime() + env.ORDER_TTL_MINUTES * 60_000)
  const values = {
    userId: BigInt(input.userId),
    productId: product.id,
    productTitle: product.title,
    currency: input.currency,
    amount,
    jettonMaster: jettonMaster && input.currency === 'USDT' ? toRawAddress(jettonMaster) : null,
    merchantAddress: env.merchantRaw,
    payerAddress: toRawAddress(payer),
    payerJettonWallet: payerJettonWallet ? toRawAddress(payerJettonWallet) : null,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  }

  let order: OrderRow | undefined
  for (let attempt = 0; attempt < 5 && !order; attempt += 1) {
    try {
      ;[order] = await db
        .insert(orders)
        .values({ id: deps.newOrderId(), ...values })
        .returning()
    } catch (error) {
      // 80 random bits practically never collide, but a retry is cheaper than a 500.
      if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error
    }
  }
  if (!order) throw new ApiError(500, 'internal_error', 'could not allocate an order id')

  const payment = buildPaymentInstructions(
    input.currency === 'TON'
      ? { currency: 'TON', orderId: order.id, amount, merchant: env.merchant.address }
      : {
          currency: 'USDT',
          orderId: order.id,
          amount,
          merchant: env.merchant.address,
          payer,
          payerJettonWallet: payerJettonWallet as Address,
          jettonMaster: jettonMaster as Address,
        },
    { env, expiresAt, queryId: deps.newQueryId() },
  )

  return { order: toOrderDto(order), payment }
}

export async function listOrders(db: Db, userId: number, limit = 50): Promise<OrderDto[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, BigInt(userId)))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit)
  return rows.map((row) => toOrderDto(row))
}

/** Orders of other users are reported as missing rather than forbidden. */
export async function getOrderForUser(db: Db, userId: number, id: string): Promise<OrderDto> {
  const [row] = await db
    .select({
      order: orders,
      payload: products.deliveryPayload,
      deliverInChat: products.deliverInChat,
    })
    .from(orders)
    .innerJoin(products, eq(products.id, orders.productId))
    .where(and(eq(orders.id, id), eq(orders.userId, BigInt(userId))))
    .limit(1)
  if (!row) throw new ApiError(404, 'not_found', 'order not found')
  return toOrderDto(row.order, { payload: row.payload, deliverInChat: row.deliverInChat })
}

/**
 * Stores the external message hash the wallet returned. This is progress information for the
 * order page only: confirmation comes from the chain, never from this call.
 */
export async function submitOrder(
  deps: Pick<OrderServiceDeps, 'db' | 'now'>,
  userId: number,
  id: string,
  boc: string,
): Promise<OrderDto> {
  let extMsgHash: string
  try {
    extMsgHash = normalizedExternalMessageHash(boc)
  } catch {
    throw new ApiError(400, 'invalid_boc', 'boc is not a signed external message')
  }
  const [existing] = await deps.db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.userId, BigInt(userId))))
    .limit(1)
  if (!existing) throw new ApiError(404, 'not_found', 'order not found')
  if (existing.extMsgHash) return toOrderDto(existing) // idempotent: keep the first attempt

  const [updated] = await deps.db
    .update(orders)
    .set({ submittedAt: deps.now(), extMsgHash, updatedAt: deps.now() })
    .where(and(eq(orders.id, id), eq(orders.userId, BigInt(userId))))
    .returning()
  return toOrderDto(updated ?? existing)
}

/** Moves pending orders past their deadline to `expired`. Paid orders are never touched. */
export async function expireOrdersOnce(db: Db, now: Date): Promise<number> {
  const rows = await db
    .update(orders)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(orders.status, 'pending'), lte(orders.expiresAt, now)))
    .returning({ id: orders.id })
  return rows.length
}

export async function listActiveProducts(db: Db) {
  return db
    .select()
    .from(products)
    .where(eq(products.isActive, true))
    .orderBy(asc(products.sortOrder), asc(products.title))
}

export function defaultOrderId(): string {
  return generateOrderId()
}
