import {
  PG_UNIQUE_VIOLATION,
  notifications,
  orders,
  payments,
  pgErrorCode,
  products,
  scanCursors,
  users,
  type Db,
  type OrderStatus,
  type PaymentStatus,
} from '@tma/db'
import type {
  AdminAttachResponse,
  AdminCursorDto,
  AdminHealthDto,
  AdminNotificationDto,
  AdminOrderDetailsDto,
  AdminOrderDto,
  AdminOrdersPageDto,
  AdminPaymentDto,
  AdminPaymentsPageDto,
  AdminProductDto,
  AdminProductInput,
  AdminProductPatch,
} from '@tma/shared'
import { ORDER_ID_RE } from '@tma/shared'
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import type { Env } from '../env'
import { ApiError, notFound } from '../errors'
import type { Candidate } from '../worker/classify'
import { NOTIFY_CLAIM_TIMEOUT_MS } from '../worker/notifier'
import { workerHeartbeat } from './health'
import { toOrderDto } from './orders'
import { settleCandidate, type SettleOutcome } from './payments'
import {
  displayAddress,
  friendly,
  tonviewerAddressUrl,
  tonviewerBase,
  tonviewerTransactionUrl,
} from './tonviewer'

/**
 * Everything the admin area can do. Access control lives in the route plugin; this module
 * assumes an administrator and concentrates on two things: never lying about money (prices are
 * validated as positive integers in the smallest units) and never bypassing the settlement
 * rules (attach goes through the same `settleCandidate` as the worker).
 */

type ProductRow = typeof products.$inferSelect
type PaymentRow = typeof payments.$inferSelect
type NotificationRow = typeof notifications.$inferSelect
type NetworkEnv = Pick<Env, 'TON_NETWORK'>

/* ------------------------------------------------------------------------ products */

const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'slug must be lowercase [a-z0-9-], 1..64')

const INT8_MAX = 2n ** 63n - 1n

/** Prices arrive in the smallest units: a positive integer that fits Postgres int8. */
const unitsSchema = z
  .string()
  .regex(/^\d{1,19}$/, 'must be a digit string in the smallest units (nanoTON, jetton units)')
  .refine((value) => {
    // zod 4 runs every check even after the regex failed, so guard before converting.
    if (!/^\d{1,19}$/.test(value)) return false
    const n = BigInt(value)
    return n > 0n && n <= INT8_MAX
  }, 'must be greater than zero')

export const adminProductInputSchema = z
  .object({
    slug: slugSchema,
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    // Rendered by the storefront: only web URLs, never javascript:/data: schemes.
    imageUrl: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .nullable()
      .optional(),
    priceTonNano: unitsSchema.nullable().optional(),
    priceUsdtUnits: unitsSchema.nullable().optional(),
    deliveryPayload: z.string().max(4000).nullable().optional(),
    deliverInChat: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .strict()

export const adminProductPatchSchema = adminProductInputSchema.partial().strict()

function toUnits(value: string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value)
}

function requirePrice(values: {
  priceTonNano: bigint | null
  priceUsdtUnits: bigint | null
}): void {
  if (values.priceTonNano === null && values.priceUsdtUnits === null) {
    throw new ApiError(400, 'price_required', 'a product needs a TON or a USDT price')
  }
}

function slugTaken(error: unknown): never {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
    throw new ApiError(409, 'slug_taken', 'another product already uses this slug')
  }
  throw error
}

export function toAdminProductDto(row: ProductRow): AdminProductDto {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    priceTonNano: row.priceTonNano?.toString() ?? null,
    priceUsdtUnits: row.priceUsdtUnits?.toString() ?? null,
    sortOrder: row.sortOrder,
    deliveryPayload: row.deliveryPayload,
    deliverInChat: row.deliverInChat,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listAdminProducts(db: Db): Promise<AdminProductDto[]> {
  const rows = await db
    .select()
    .from(products)
    .orderBy(asc(products.sortOrder), asc(products.title))
  return rows.map(toAdminProductDto)
}

export async function createAdminProduct(
  db: Db,
  input: AdminProductInput,
  now: Date,
): Promise<AdminProductDto> {
  const values = {
    slug: input.slug,
    title: input.title,
    description: input.description ?? '',
    imageUrl: input.imageUrl ?? null,
    priceTonNano: toUnits(input.priceTonNano),
    priceUsdtUnits: toUnits(input.priceUsdtUnits),
    deliveryPayload: input.deliveryPayload ?? null,
    deliverInChat: input.deliverInChat ?? false,
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  }
  requirePrice(values)
  try {
    const [row] = await db.insert(products).values(values).returning()
    if (!row) throw new Error('product insert returned no row')
    return toAdminProductDto(row)
  } catch (error) {
    return slugTaken(error)
  }
}

/** PATCH semantics: absent = keep, null = clear. The merged row must still carry a price. */
export async function updateAdminProduct(
  db: Db,
  id: string,
  patch: AdminProductPatch,
  now: Date,
): Promise<AdminProductDto> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(products).where(eq(products.id, id)).for('update')
    if (!current) throw notFound('product not found')
    const next = {
      slug: patch.slug ?? current.slug,
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      imageUrl: patch.imageUrl === undefined ? current.imageUrl : patch.imageUrl,
      priceTonNano:
        patch.priceTonNano === undefined ? current.priceTonNano : toUnits(patch.priceTonNano),
      priceUsdtUnits:
        patch.priceUsdtUnits === undefined ? current.priceUsdtUnits : toUnits(patch.priceUsdtUnits),
      deliveryPayload:
        patch.deliveryPayload === undefined ? current.deliveryPayload : patch.deliveryPayload,
      deliverInChat: patch.deliverInChat ?? current.deliverInChat,
      isActive: patch.isActive ?? current.isActive,
      sortOrder: patch.sortOrder ?? current.sortOrder,
      updatedAt: now,
    }
    requirePrice(next)
    try {
      const [row] = await tx.update(products).set(next).where(eq(products.id, id)).returning()
      if (!row) throw notFound('product not found')
      return toAdminProductDto(row)
    } catch (error) {
      return slugTaken(error)
    }
  })
}

/* ------------------------------------------------------------------------ keyset cursor */

/**
 * Pages are keyed by `(created_at, id)`. The timestamp travels in the cursor as microseconds
 * since the epoch, computed by Postgres: a JavaScript Date keeps milliseconds only, and a
 * truncated key would skip or repeat rows created within the same millisecond. An integer is
 * also independent of the session's DateStyle and cannot smuggle an unparsable literal into
 * the query, which is why the cursor is not the printed timestamp.
 */
const MICROS_RE = /^\d{1,19}$/

export interface PageCursor {
  /** Microseconds since the epoch, as printed by Postgres. */
  t: string
  id: string
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** `idSchema` is the id format of the paged table, so a forged id fails here, not in SQL. */
export function decodeCursor(raw: string, idSchema: z.ZodType<string>): PageCursor {
  const schema = z.object({ t: z.string().regex(MICROS_RE), id: idSchema }).strict()
  try {
    return schema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'cursor is not a page cursor from this API')
  }
}

const orderIdSchema = z.string().regex(ORDER_ID_RE)
const uuidSchema = z.uuid()

/** `created_at` as exact microseconds, the same value the cursor carries back. */
const createdMicros = (column: { getSQL: () => unknown }) =>
  sql<string>`(extract(epoch from ${column}) * 1000000)::bigint::text`

/** The cursor timestamp back to a timestamptz without any text parsing. */
const cursorTimestamp = (micros: string) =>
  sql`('epoch'::timestamptz + ${micros}::bigint * interval '1 microsecond')`

export interface PageParams {
  limit: number
  cursor?: string | undefined
}

/* ------------------------------------------------------------------------ orders */

const orderSelection = {
  order: orders,
  userFirstName: users.firstName,
  userUsername: users.username,
  payload: products.deliveryPayload,
  deliverInChat: products.deliverInChat,
  createdAtMicros: createdMicros(orders.createdAt),
}

type OrderJoinRow = {
  order: typeof orders.$inferSelect
  userFirstName: string | null
  userUsername: string | null
  payload: string | null
  deliverInChat: boolean
  createdAtMicros: string
}

function orderQuery(db: Db) {
  return db
    .select(orderSelection)
    .from(orders)
    .leftJoin(users, eq(users.telegramId, orders.userId))
    .innerJoin(products, eq(products.id, orders.productId))
}

export function toAdminOrderDto(row: OrderJoinRow): AdminOrderDto {
  const { order } = row
  return {
    ...toOrderDto(order, { payload: row.payload, deliverInChat: row.deliverInChat }),
    userId: order.userId.toString(),
    userFirstName: row.userFirstName,
    userUsername: row.userUsername,
    jettonMaster: order.jettonMaster,
    merchantAddress: order.merchantAddress,
    payerAddress: order.payerAddress,
    extMsgHash: order.extMsgHash,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    cancelledBy: order.cancelledBy?.toString() ?? null,
    adminNote: order.adminNote,
    updatedAt: order.updatedAt.toISOString(),
  }
}

export interface ListOrdersParams extends PageParams {
  status?: OrderStatus | undefined
}

export async function listAdminOrders(
  db: Db,
  params: ListOrdersParams,
): Promise<AdminOrdersPageDto> {
  const cursor = params.cursor ? decodeCursor(params.cursor, orderIdSchema) : null
  const conditions = []
  if (params.status) conditions.push(eq(orders.status, params.status))
  if (cursor) {
    conditions.push(
      sql`(${orders.createdAt}, ${orders.id}) < (${cursorTimestamp(cursor.t)}, ${cursor.id})`,
    )
  }
  const rows = await orderQuery(db)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(params.limit + 1)
  const page = rows.slice(0, params.limit)
  const last = rows.length > params.limit ? page[page.length - 1] : undefined
  return {
    orders: page.map(toAdminOrderDto),
    nextCursor: last ? encodeCursor({ t: last.createdAtMicros, id: last.order.id }) : null,
  }
}

async function readAdminOrder(db: Db, id: string): Promise<AdminOrderDto> {
  const [row] = await orderQuery(db).where(eq(orders.id, id))
  if (!row) throw notFound('order not found')
  return toAdminOrderDto(row)
}

export function toAdminNotificationDto(row: NotificationRow): AdminNotificationDto {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    telegramUserId: row.telegramUserId.toString(),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    claimedAt: row.claimedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    telegramMessageId: row.telegramMessageId?.toString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function getAdminOrder(
  db: Db,
  env: NetworkEnv,
  id: string,
): Promise<AdminOrderDetailsDto> {
  const order = await readAdminOrder(db, id)
  const paymentRows = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, id))
    .orderBy(desc(payments.txLt))
  const notificationRows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.orderId, id))
    .orderBy(asc(notifications.createdAt))
  return {
    order,
    payments: paymentRows.map((row) => toAdminPaymentDto(row, env)),
    notifications: notificationRows.map(toAdminNotificationDto),
  }
}

export interface CancelOrderInput {
  adminId: bigint
  note?: string | undefined
  now: Date
}

/** `pending | expired → cancelled` in one statement, so a payment landing at the same moment wins or loses atomically. */
export async function cancelAdminOrder(
  db: Db,
  id: string,
  input: CancelOrderInput,
): Promise<AdminOrderDto> {
  const [updated] = await db
    .update(orders)
    .set({
      status: 'cancelled',
      cancelledAt: input.now,
      cancelledBy: input.adminId,
      updatedAt: input.now,
      ...(input.note !== undefined ? { adminNote: input.note } : {}),
    })
    .where(and(eq(orders.id, id), inArray(orders.status, ['pending', 'expired'])))
    .returning({ id: orders.id })
  if (!updated) {
    const [existing] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, id))
    if (!existing) throw notFound('order not found')
    throw new ApiError(
      409,
      'order_not_cancellable',
      `a ${existing.status} order cannot be cancelled`,
    )
  }
  return readAdminOrder(db, id)
}

/**
 * Puts the order's `order_paid` row back into the outbox with a fresh attempt budget. A row
 * the notifier claimed within the claim window is being sent right now: resetting it would
 * discard the notifier's fenced outcome and deliver the message twice, so that case is refused.
 */
export async function resendAdminNotification(
  db: Db,
  id: string,
  now: Date,
): Promise<AdminNotificationDto> {
  const [order] = await db
    .select({ status: orders.status, userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, id))
  if (!order) throw notFound('order not found')
  if (order.status !== 'paid') {
    throw new ApiError(409, 'order_not_paid', 'only a paid order has a notification to resend')
  }
  const staleBefore = new Date(now.getTime() - NOTIFY_CLAIM_TIMEOUT_MS)
  const [row] = await db
    .insert(notifications)
    .values({
      orderId: id,
      kind: 'order_paid',
      telegramUserId: order.userId,
      nextAttemptAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [notifications.orderId, notifications.kind],
      set: {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        claimedAt: null,
        sentAt: null,
        telegramMessageId: null,
        lastError: null,
      },
      setWhere: or(
        ne(notifications.status, 'pending'),
        isNull(notifications.claimedAt),
        lt(notifications.claimedAt, staleBefore),
      ),
    })
    .returning()
  if (!row) {
    throw new ApiError(
      409,
      'notification_in_flight',
      'the notification is being sent right now; try again in a few minutes',
    )
  }
  return toAdminNotificationDto(row)
}

/* ------------------------------------------------------------------------ payments */

export function toAdminPaymentDto(row: PaymentRow, env: NetworkEnv): AdminPaymentDto {
  const network = env.TON_NETWORK
  return {
    id: row.id,
    account: row.account,
    txHash: row.txHash,
    txLt: row.txLt.toString(),
    txNow: row.txNow.toISOString(),
    mcBlockSeqno: row.mcBlockSeqno.toString(),
    traceId: row.traceId,
    currency: row.currency,
    jettonMaster: row.jettonMaster,
    sourceWallet: row.sourceWallet,
    amount: row.amount.toString(),
    senderAddress: row.senderAddress,
    comment: row.comment,
    orderId: row.orderId,
    status: row.status,
    reason: row.reason,
    payerMismatch: row.payerMismatch,
    attachedBy: row.attachedBy?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
    tonviewerUrl: tonviewerTransactionUrl(network, row.txHash),
    senderUrl: row.senderAddress
      ? tonviewerAddressUrl(row.senderAddress, { contract: false, network })
      : null,
  }
}

export interface ListPaymentsParams extends PageParams {
  status?: PaymentStatus | undefined
}

export async function listAdminPayments(
  db: Db,
  env: NetworkEnv,
  params: ListPaymentsParams,
): Promise<AdminPaymentsPageDto> {
  const cursor = params.cursor ? decodeCursor(params.cursor, uuidSchema) : null
  const conditions = []
  if (params.status) conditions.push(eq(payments.status, params.status))
  if (cursor) {
    conditions.push(
      sql`(${payments.createdAt}, ${payments.id}) < (${cursorTimestamp(cursor.t)}, ${cursor.id}::uuid)`,
    )
  }
  const rows = await db
    .select({ payment: payments, createdAtMicros: createdMicros(payments.createdAt) })
    .from(payments)
    .where(and(...conditions))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(params.limit + 1)
  const page = rows.slice(0, params.limit)
  const last = rows.length > params.limit ? page[page.length - 1] : undefined
  return {
    payments: page.map((row) => toAdminPaymentDto(row.payment, env)),
    nextCursor: last ? encodeCursor({ t: last.createdAtMicros, id: last.payment.id }) : null,
  }
}

export interface AttachPaymentInput {
  paymentId: string
  orderId: string
  force: boolean
  adminId: bigint
  now: Date
}

function attachRejected(outcome: SettleOutcome): ApiError {
  switch (outcome.reason) {
    case 'order_not_found':
      return notFound('order not found')
    case 'currency_mismatch':
      return new ApiError(
        422,
        'currency_mismatch',
        'the payment asset differs from the order currency; it cannot be attached',
      )
    case 'order_already_paid':
      return new ApiError(409, 'order_already_paid', 'the order is already paid')
    case 'order_cancelled':
      return new ApiError(409, 'order_cancelled', 'the order is cancelled')
    default:
      break
  }
  if (outcome.status === 'underpaid') {
    return new ApiError(
      422,
      'underpaid',
      'the payment is below the order amount; repeat with force to accept it',
    )
  }
  return new ApiError(409, 'payment_not_attachable', `settlement answered ${outcome.status}`)
}

/**
 * Manual settlement of an `unmatched` or `underpaid` row. The same `settleCandidate` as the
 * worker decides, so an administrator can override the amount (with `force`) but never the
 * asset. A rejected attach throws inside the transaction, which rolls back the bookkeeping the
 * settlement wrote and leaves the ledger row exactly as it was.
 */
export async function attachAdminPayment(
  db: Db,
  env: NetworkEnv,
  input: AttachPaymentInput,
): Promise<AdminAttachResponse> {
  await db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .for('update')
    if (!payment) throw notFound('payment not found')
    const attachable =
      (payment.status === 'unmatched' || payment.status === 'underpaid') &&
      payment.currency !== null &&
      (payment.currency === 'TON' || payment.jettonMaster !== null)
    if (!attachable) {
      throw new ApiError(
        409,
        'payment_not_attachable',
        `a ${payment.status} payment cannot be attached`,
      )
    }
    const candidate: Candidate =
      payment.currency === 'TON'
        ? {
            kind: 'candidate',
            currency: 'TON',
            jettonMaster: null,
            amount: payment.amount,
            sender: payment.senderAddress,
            comment: payment.comment,
            abortedNonBounceable: false,
          }
        : {
            kind: 'candidate',
            currency: 'USDT',
            jettonMaster: payment.jettonMaster ?? '',
            amount: payment.amount,
            sender: payment.senderAddress,
            comment: payment.comment,
            abortedNonBounceable: false,
          }
    const outcome = await settleCandidate(tx, {
      paymentId: payment.id,
      candidate,
      target: {
        kind: 'order',
        orderId: input.orderId,
        attachedBy: input.adminId,
        force: input.force,
      },
      paidAt: payment.txNow,
      now: input.now,
    })
    if (outcome.status !== 'matched') throw attachRejected(outcome)
  })

  const [payment] = await db.select().from(payments).where(eq(payments.id, input.paymentId))
  if (!payment) throw notFound('payment not found')
  return {
    payment: toAdminPaymentDto(payment, env),
    order: await readAdminOrder(db, input.orderId),
  }
}

/* ------------------------------------------------------------------------ health */

type HealthEnv = Pick<
  Env,
  'TON_NETWORK' | 'WORKER_POLL_MS' | 'merchant' | 'merchantRaw' | 'usdtMaster' | 'usdtMasterRaw'
>

async function countByStatus<T extends string>(
  db: Db,
  table: typeof payments | typeof notifications | typeof orders,
): Promise<Map<T, number>> {
  const rows = await db
    .select({ status: table.status, n: sql<number>`count(*)::int` })
    .from(table)
    .groupBy(table.status)
  return new Map(rows.map((row) => [row.status as T, row.n]))
}

export async function adminHealth(db: Db, env: HealthEnv, now: Date): Promise<AdminHealthDto> {
  const network = env.TON_NETWORK
  const pollMs = env.WORKER_POLL_MS
  const cursorRows = await db.select().from(scanCursors).orderBy(asc(scanCursors.label))

  const cursors: AdminCursorDto[] = cursorRows.map((row) => {
    const contract = row.label === 'usdt_jetton_wallet'
    // Same rule as /health: a cursor that never polled counts from its registration.
    const effective = row.lastPolledAt ?? row.updatedAt
    const ageSec = Math.max(0, Math.floor((now.getTime() - effective.getTime()) / 1000))
    return {
      account: row.account,
      address: displayAddress(row.account, { contract, network }) ?? row.account,
      url: tonviewerAddressUrl(row.account, { contract, network }) ?? tonviewerBase(network),
      label: row.label,
      startLt: row.startLt.toString(),
      lastLt: row.lastLt.toString(),
      lastHash: row.lastHash,
      lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
      lagSeconds: row.lastPolledAt
        ? Math.max(0, Math.floor((now.getTime() - row.lastPolledAt.getTime()) / 1000))
        : null,
      stale: ageSec > (3 * pollMs) / 1000,
      lastError: row.lastError,
      updatedAt: row.updatedAt.toISOString(),
    }
  })

  const paymentCounts = await countByStatus<PaymentStatus>(db, payments)
  const notificationCounts = await countByStatus<'pending' | 'sent' | 'failed'>(db, notifications)
  const orderCounts = await countByStatus<OrderStatus>(db, orders)

  return {
    now: now.toISOString(),
    network,
    pollMs,
    merchant: {
      raw: env.merchantRaw,
      address: friendly(env.merchant.address, { contract: false, network }),
      url: `${tonviewerBase(network)}/${friendly(env.merchant.address, { contract: false, network })}`,
    },
    usdtMaster:
      env.usdtMaster && env.usdtMasterRaw
        ? {
            raw: env.usdtMasterRaw,
            address: friendly(env.usdtMaster.address, { contract: true, network }),
            url: `${tonviewerBase(network)}/${friendly(env.usdtMaster.address, { contract: true, network })}`,
          }
        : null,
    worker: workerHeartbeat(cursorRows, now, pollMs),
    cursors,
    counts: {
      unmatchedPayments: paymentCounts.get('unmatched') ?? 0,
      underpaidPayments: paymentCounts.get('underpaid') ?? 0,
      ignoredPayments: paymentCounts.get('ignored') ?? 0,
      failedNotifications: notificationCounts.get('failed') ?? 0,
      pendingNotifications: notificationCounts.get('pending') ?? 0,
      pendingOrders: orderCounts.get('pending') ?? 0,
      paidOrders: orderCounts.get('paid') ?? 0,
    },
  }
}
