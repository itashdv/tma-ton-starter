import { notifications, orders, payments, scanCursors, type Db, type PaymentStatus } from '@tma/db'
import { isOrderId, normalizeComment } from '@tma/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'

import type { Candidate, Ignored, PaymentReason } from '../worker/classify'

/**
 * Settlement of one on-chain transaction, exactly once, in one database transaction:
 *
 *   1. INSERT the ledger row `ON CONFLICT (tx_hash) DO NOTHING RETURNING id`. No row back means
 *      another run (or a concurrent connection, which waited on the unique index until we
 *      committed) already owns this transaction: `{ duplicate: true }`, nothing else happens.
 *   2. Resolve the order from the comment and lock it with `SELECT ... FOR UPDATE`, so two
 *      different payments for one order are serialised and the second sees `paid`.
 *   3. Decide: not found / currency mismatch / already paid / cancelled / underpaid / payable.
 *   4. Payable: compare-and-set the order to `paid` (`WHERE status IN ('pending','expired')`),
 *      mark the ledger row `matched` and queue the notification in the outbox.
 *   5. Otherwise record the status and reason on the ledger row.
 *   6. Advance the scan cursor with a GREATEST guard, when asked to.
 *
 * Any failure rolls back all six steps together, so a crash can never leave a paid order
 * without its ledger row, a ledger row without its cursor move, or a moved cursor without
 * the payment. The partial unique index on `(order_id) WHERE status = 'matched'` is the
 * last line of defence should the logic above ever be bypassed.
 */

type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export interface PaymentEvent {
  /** Scanned account (raw form) the transaction belongs to. */
  account: string
  /** Lowercase hex. */
  txHash: string
  txLt: bigint
  txNow: Date
  mcBlockSeqno: bigint
  traceId: string | null
  classification: Candidate | Ignored
  /** The toncenter row verbatim, for audits. */
  raw: unknown
}

export interface ApplyPaymentOptions {
  /** Move the account cursor to this transaction inside the same database transaction. */
  touchCursor: boolean
  /** Worker clock; stamps created_at / next_attempt_at so tests can drive time. */
  now: Date
}

export interface SettleOutcome {
  status: PaymentStatus
  reason: PaymentReason | null
  orderId: string | null
  /** True when an `order_paid` notification was queued by this call. */
  notified: boolean
}

export type ApplyPaymentResult =
  { duplicate: true } | ({ duplicate: false; paymentId: string } & SettleOutcome)

export type SettleTarget =
  /** The order named by the on-chain comment. */
  | { kind: 'comment' }
  /** An order chosen by an administrator (stage D attach). */
  | { kind: 'order'; orderId: string; attachedBy: bigint; force: boolean }

export interface SettleInput {
  paymentId: string
  candidate: Candidate
  target: SettleTarget
  /** When the funds arrived on-chain; becomes `orders.paid_at`. */
  paidAt: Date
  now: Date
}

export class SettleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettleError'
  }
}

/** The order id a comment refers to, or null when the comment cannot name one. */
export function orderIdFromComment(comment: string | null): string | null {
  if (comment === null) return null
  const normalized = normalizeComment(comment)
  return isOrderId(normalized) ? normalized : null
}

async function recordOutcome(
  executor: Executor,
  paymentId: string,
  outcome: { status: PaymentStatus; reason: PaymentReason | null; orderId: string | null },
): Promise<void> {
  await executor
    .update(payments)
    .set({ status: outcome.status, reason: outcome.reason, orderId: outcome.orderId })
    .where(eq(payments.id, paymentId))
}

/**
 * Steps 2-5. Runs inside the caller's transaction, which must already hold the payment row:
 * `applyPayment` owns it by having just inserted it; an administrative attach (stage D) has to
 * `SELECT ... FOR UPDATE` the row first and verify it is still `unmatched` or `underpaid`.
 */
export async function settleCandidate(
  executor: Executor,
  input: SettleInput,
): Promise<SettleOutcome> {
  const { candidate, paymentId, target } = input

  let orderId: string | null
  if (target.kind === 'order') {
    orderId = target.orderId
  } else {
    const comment = candidate.comment === null ? '' : normalizeComment(candidate.comment)
    if (comment === '') {
      const outcome = { status: 'unmatched' as const, reason: 'no_comment' as const, orderId: null }
      await recordOutcome(executor, paymentId, outcome)
      return { ...outcome, notified: false }
    }
    orderId = isOrderId(comment) ? comment : null
  }

  const [order] = orderId
    ? await executor.select().from(orders).where(eq(orders.id, orderId)).for('update')
    : []
  if (!order) {
    const outcome = {
      status: 'unmatched' as const,
      reason: 'order_not_found' as const,
      orderId: null,
    }
    await recordOutcome(executor, paymentId, outcome)
    return { ...outcome, notified: false }
  }

  const sameAsset =
    order.currency === candidate.currency &&
    (candidate.currency !== 'USDT' || order.jettonMaster === candidate.jettonMaster)
  let blocked: PaymentReason | null = null
  if (!sameAsset) blocked = 'currency_mismatch'
  else if (order.status === 'paid') blocked = 'order_already_paid'
  else if (order.status === 'cancelled') blocked = 'order_cancelled'
  if (blocked !== null) {
    const outcome = { status: 'unmatched' as const, reason: blocked, orderId: order.id }
    await recordOutcome(executor, paymentId, outcome)
    return { ...outcome, notified: false }
  }

  const force = target.kind === 'order' && target.force
  if (candidate.amount < order.amount && !force) {
    const outcome = { status: 'underpaid' as const, reason: null, orderId: order.id }
    await recordOutcome(executor, paymentId, outcome)
    return { ...outcome, notified: false }
  }

  // Compare-and-set although the row is locked: the status predicate is the invariant, the
  // lock only makes the wait deterministic.
  const [paid] = await executor
    .update(orders)
    .set({
      status: 'paid',
      paidAt: input.paidAt,
      paidLate: order.status === 'expired' || input.paidAt > order.expiresAt,
      updatedAt: input.now,
    })
    .where(and(eq(orders.id, order.id), inArray(orders.status, ['pending', 'expired'])))
    .returning({ id: orders.id })
  if (!paid) {
    throw new SettleError(`order ${order.id} changed status while locked`)
  }

  const payerMismatch =
    order.payerAddress !== null &&
    candidate.sender !== null &&
    order.payerAddress !== candidate.sender
  const reason: PaymentReason | null =
    target.kind === 'order'
      ? 'manual'
      : candidate.abortedNonBounceable
        ? 'aborted_nonbounceable'
        : null
  await executor
    .update(payments)
    .set({
      status: 'matched',
      reason,
      orderId: order.id,
      payerMismatch,
      attachedBy: target.kind === 'order' ? target.attachedBy : null,
    })
    .where(eq(payments.id, paymentId))

  const queued = await executor
    .insert(notifications)
    .values({
      orderId: order.id,
      kind: 'order_paid',
      telegramUserId: order.userId,
      nextAttemptAt: input.now,
      createdAt: input.now,
    })
    .onConflictDoNothing({ target: [notifications.orderId, notifications.kind] })
    .returning({ id: notifications.id })

  return { status: 'matched', reason, orderId: order.id, notified: queued.length > 0 }
}

/**
 * Moves the cursor forward, never back: a late re-scan or a retried batch may present an
 * older transaction, and the guard makes that harmless. Returns false when the account has no
 * cursor row (the worker registers one at startup, so that is a bug, not a race).
 */
export async function advanceCursor(
  executor: Executor,
  account: string,
  lt: bigint,
  hash: string,
  now: Date,
): Promise<boolean> {
  const rows = await executor
    .update(scanCursors)
    .set({
      lastLt: sql`GREATEST(${scanCursors.lastLt}, ${lt.toString()}::bigint)`,
      lastHash: sql`CASE WHEN ${lt.toString()}::bigint > ${scanCursors.lastLt} THEN ${hash} ELSE ${scanCursors.lastHash} END`,
      updatedAt: now,
    })
    .where(eq(scanCursors.account, account))
    .returning({ account: scanCursors.account })
  return rows.length > 0
}

export async function applyPayment(
  db: Db,
  event: PaymentEvent,
  options: ApplyPaymentOptions,
): Promise<ApplyPaymentResult> {
  const c = event.classification
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(payments)
      .values({
        account: event.account,
        txHash: event.txHash,
        txLt: event.txLt,
        txNow: event.txNow,
        mcBlockSeqno: event.mcBlockSeqno,
        traceId: event.traceId,
        currency: c.currency,
        jettonMaster: c.jettonMaster,
        sourceWallet: c.kind === 'ignored' ? c.sourceWallet : null,
        amount: c.amount,
        senderAddress: c.sender,
        comment: c.comment,
        status: c.kind === 'ignored' ? 'ignored' : 'unmatched',
        reason: c.kind === 'ignored' ? c.reason : null,
        raw: event.raw,
        createdAt: options.now,
      })
      .onConflictDoNothing({ target: payments.txHash })
      .returning({ id: payments.id })
    if (!inserted) return { duplicate: true }

    const outcome: SettleOutcome =
      c.kind === 'ignored'
        ? { status: 'ignored', reason: c.reason, orderId: null, notified: false }
        : await settleCandidate(tx, {
            paymentId: inserted.id,
            candidate: c,
            target: { kind: 'comment' },
            paidAt: event.txNow,
            now: options.now,
          })

    if (options.touchCursor) {
      const moved = await advanceCursor(tx, event.account, event.txLt, event.txHash, options.now)
      if (!moved) throw new SettleError(`no scan cursor registered for ${event.account}`)
    }
    return { duplicate: false, paymentId: inserted.id, ...outcome }
  })
}
