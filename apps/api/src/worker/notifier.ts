import { notifications, orders, products, users, type Db } from '@tma/db'
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import type pino from 'pino'

import type { LoadedShopConfig } from '../config/shop'
import type { Env } from '../env'
import type { BotApi } from '../telegram/bot-api'
import { orderDeepLink, renderOrderPaid } from '../telegram/templates'

/**
 * Delivers rows of the `notifications` outbox to Telegram, at least once.
 *
 * A row is claimed in one autocommit statement (`claimed_at`, `attempts + 1`, FOR UPDATE SKIP
 * LOCKED) so that several worker processes never send the same row concurrently. The HTTP
 * call happens outside any transaction: holding a row lock across a 10 s Bot API timeout would
 * serialise the whole queue. The price is a crash between the send and the outcome update,
 * which re-sends that one row after the claim window expires. That duplicate is accepted; a
 * lost notification is not.
 */

export const NOTIFY_CLAIM_LIMIT = 10
export const NOTIFY_MAX_ATTEMPTS = 8
/** A claim older than this belongs to a worker that died mid-send; the row is fair game. */
export const NOTIFY_CLAIM_TIMEOUT_MS = 5 * 60_000
export const NOTIFY_BACKOFF_BASE_MS = 5_000
export const NOTIFY_BACKOFF_MAX_MS = 10 * 60_000

/** 5 s, 10 s, 20 s … capped at 10 min; `attempts` is the count including the failed one. */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(1, Math.floor(attempts)) - 1
  return Math.min(NOTIFY_BACKOFF_BASE_MS * 2 ** exponent, NOTIFY_BACKOFF_MAX_MS)
}

export interface NotifierDeps {
  db: Db
  botApi: BotApi
  shop: LoadedShopConfig
  env: Pick<Env, 'TELEGRAM_BOT_USERNAME' | 'TELEGRAM_MINIAPP_SHORT_NAME'>
  now: () => Date
  log: pino.Logger
  claimLimit?: number
}

export interface NotifyOnceResult {
  claimed: number
  sent: number
  failed: number
  /** Rows scheduled for another try (rate limited or transient failure). */
  deferred: number
}

type NotificationRow = typeof notifications.$inferSelect

async function claimBatch(deps: NotifierDeps, now: Date): Promise<NotificationRow[]> {
  const staleBefore = new Date(now.getTime() - NOTIFY_CLAIM_TIMEOUT_MS)
  const due = deps.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.status, 'pending'),
        lte(notifications.nextAttemptAt, now),
        or(isNull(notifications.claimedAt), lt(notifications.claimedAt, staleBefore)),
      ),
    )
    .orderBy(asc(notifications.nextAttemptAt), asc(notifications.createdAt))
    .limit(deps.claimLimit ?? NOTIFY_CLAIM_LIMIT)
    .for('update', { skipLocked: true })

  return deps.db
    .update(notifications)
    .set({ claimedAt: now, attempts: sql`${notifications.attempts} + 1` })
    .where(inArray(notifications.id, due))
    .returning()
}

interface OrderContext {
  productTitle: string
  languageCode: string | null
  payload: string | null
  deliverInChat: boolean
}

/** One query for the whole batch; a missing user or product leaves those fields null. */
async function loadContexts(db: Db, orderIds: string[]): Promise<Map<string, OrderContext>> {
  const rows = await db
    .select({
      orderId: orders.id,
      productTitle: orders.productTitle,
      userId: users.telegramId,
      languageCode: users.languageCode,
      payload: products.deliveryPayload,
      deliverInChat: products.deliverInChat,
    })
    .from(orders)
    .leftJoin(users, eq(users.telegramId, orders.userId))
    .leftJoin(products, eq(products.id, orders.productId))
    .where(inArray(orders.id, orderIds))

  const contexts = new Map<string, OrderContext>()
  for (const row of rows) {
    if (row.userId === null) continue // reported as "user missing" by the caller
    contexts.set(row.orderId, {
      productTitle: row.productTitle,
      languageCode: row.languageCode,
      payload: row.payload,
      deliverInChat: row.deliverInChat ?? false,
    })
  }
  return contexts
}

export async function notifyOnce(deps: NotifierDeps): Promise<NotifyOnceResult> {
  const { db, log } = deps
  const result: NotifyOnceResult = { claimed: 0, sent: 0, failed: 0, deferred: 0 }

  const batch = await claimBatch(deps, deps.now())
  result.claimed = batch.length
  if (batch.length === 0) return result

  const contexts = await loadContexts(
    db,
    batch.map((row) => row.orderId),
  )

  for (const row of batch) {
    const context = contexts.get(row.orderId)
    if (!context) {
      // Foreign keys make this unreachable; recorded rather than retried so it is visible.
      await db
        .update(notifications)
        .set({ status: 'failed', lastError: 'order or user row is missing' })
        .where(eq(notifications.id, row.id))
      result.failed += 1
      log.error({ notificationId: row.id, orderId: row.orderId }, 'notification has no order')
      continue
    }

    const message = renderOrderPaid(deps.shop, {
      orderId: row.orderId,
      productTitle: context.productTitle,
      languageCode: context.languageCode,
      delivery: { payload: context.payload, deliverInChat: context.deliverInChat },
      deepLink: orderDeepLink(deps.env, row.orderId),
    })
    const outcome = await deps.botApi.sendMessage({
      chatId: row.telegramUserId,
      text: message.text,
      replyMarkup: message.replyMarkup,
      protectContent: message.protectContent,
    })

    const now = deps.now()
    const base = { notificationId: row.id, orderId: row.orderId, attempts: row.attempts }
    // Fenced by our own claim stamp: a send that outlived the claim window must not overwrite
    // the outcome another worker recorded for the row in the meantime.
    const ours = row.claimedAt
      ? and(eq(notifications.id, row.id), eq(notifications.claimedAt, row.claimedAt))
      : eq(notifications.id, row.id)
    const record = async (values: PgUpdateSetSource<typeof notifications>) => {
      const updated = await db
        .update(notifications)
        .set(values)
        .where(ours)
        .returning({ id: notifications.id })
      if (updated.length === 0) {
        log.warn(base, 'notification outcome discarded: the row was reclaimed meanwhile')
      }
    }
    switch (outcome.kind) {
      case 'ok': {
        await record({
          status: 'sent',
          sentAt: now,
          telegramMessageId: outcome.messageId,
          lastError: null,
        })
        result.sent += 1
        log.info({ ...base, messageId: outcome.messageId.toString() }, 'notification sent')
        break
      }
      case 'final': {
        await record({ status: 'failed', lastError: outcome.error })
        result.failed += 1
        log.warn({ ...base, error: outcome.error }, 'notification rejected by Telegram')
        break
      }
      case 'rate_limited': {
        // The row did nothing wrong: give the attempt back and wait exactly as long as asked.
        await record({
          nextAttemptAt: new Date(now.getTime() + outcome.retryAfterSec * 1000),
          attempts: sql`${notifications.attempts} - 1`,
          claimedAt: null,
          lastError: outcome.error,
        })
        result.deferred += 1
        log.warn({ ...base, retryAfterSec: outcome.retryAfterSec }, 'notification rate limited')
        break
      }
      case 'retry': {
        if (row.attempts >= NOTIFY_MAX_ATTEMPTS) {
          await record({ status: 'failed', lastError: outcome.error })
          result.failed += 1
          log.error({ ...base, error: outcome.error }, 'notification failed permanently')
          break
        }
        const delayMs = retryDelayMs(row.attempts)
        await record({
          nextAttemptAt: new Date(now.getTime() + delayMs),
          claimedAt: null,
          lastError: outcome.error,
        })
        result.deferred += 1
        log.warn({ ...base, delayMs, error: outcome.error }, 'notification deferred')
        break
      }
    }
  }

  return result
}
