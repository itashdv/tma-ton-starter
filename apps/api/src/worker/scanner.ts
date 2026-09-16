import { scanCursors, type Db, type ScanCursorLabel } from '@tma/db'
import { eq } from 'drizzle-orm'
import type pino from 'pino'

import {
  advanceCursor,
  applyPayment,
  type ApplyPaymentOptions,
  type ApplyPaymentResult,
  type PaymentEvent,
} from '../services/payments'
import { normalizeHash } from '../ton/hash'
import type { ToncenterClient } from '../ton/toncenter'
import type { ToncenterTransaction } from '../ton/toncenter.schemas'
import { classifyTransaction, type Candidate, type ClassifyContext, type Ignored } from './classify'
import { isFinal } from './finality'

/**
 * One cursor per scanned account: `(last_lt, last_hash)` of the last transaction that was
 * fully handled. Logical time is strictly increasing inside an account's transaction chain,
 * which makes `start_lt=last_lt&sort=asc` an exact "everything after" query (the row with
 * `last_hash` itself is skipped); wall-clock time gives no such guarantee. The cursor only
 * moves to the last row that was completely processed, so a crash re-reads at most the rows
 * whose effects were never committed, and every committed row is protected by `tx_hash`.
 */

export type ApplyFn = (
  db: Db,
  event: PaymentEvent,
  options: ApplyPaymentOptions,
) => Promise<ApplyPaymentResult>

export interface ScanAccount {
  /** Raw form, as stored in `scan_cursors.account`. */
  account: string
  label: ScanCursorLabel
}

export interface ScannerDeps {
  db: Db
  ton: ToncenterClient
  log: pino.Logger
  now: () => Date
  /** `limit` of one `/transactions` page. */
  batchLimit: number
  /** Pages per poll before yielding to the other loop steps; the cursor carries the rest over. */
  maxPages?: number
  ctx: ClassifyContext
  /** Settlement function; injectable so tests can fail a specific row. */
  apply?: ApplyFn
  /** Process stop signal: checked between pages, so a stop never waits for a whole backlog. */
  signal?: AbortSignal
}

export interface ScanSummary {
  account: string
  fetched: number
  applied: number
  duplicates: number
  skipped: number
  /** A non-final row ended the batch early; the rest is read on the next poll. */
  stoppedAtNonFinal: boolean
  /** The page budget ran out with rows still pending. */
  moreAvailable: boolean
  error: string | null
  cursor: { lastLt: bigint; lastHash: string | null }
}

export interface RescanSummary {
  account: string
  fetched: number
  /** Rows the cursor scan had missed; anything above zero deserves attention. */
  recovered: number
  duplicates: number
  error: string | null
}

export const DEFAULT_MAX_PAGES = 10

const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

export function toPaymentEvent(
  tx: ToncenterTransaction,
  classification: Candidate | Ignored,
  account: string,
): PaymentEvent {
  return {
    account,
    txHash: normalizeHash(tx.hash),
    txLt: BigInt(tx.lt),
    txNow: new Date(tx.now * 1000),
    mcBlockSeqno: BigInt(tx.mc_block_seqno ?? 0),
    traceId: tx.trace_id ?? null,
    classification,
    raw: tx,
  }
}

async function readCursor(db: Db, account: string) {
  const [cursor] = await db
    .select({
      startLt: scanCursors.startLt,
      lastLt: scanCursors.lastLt,
      lastHash: scanCursors.lastHash,
    })
    .from(scanCursors)
    .where(eq(scanCursors.account, account))
  if (!cursor) throw new Error(`no scan cursor registered for ${account}`)
  return cursor
}

export async function scanAccountOnce(
  deps: ScannerDeps,
  target: ScanAccount,
): Promise<ScanSummary> {
  const { db, ton, log } = deps
  const apply = deps.apply ?? applyPayment
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES
  const account = target.account
  const start = await readCursor(db, account)

  const summary: ScanSummary = {
    account,
    fetched: 0,
    applied: 0,
    duplicates: 0,
    skipped: 0,
    stoppedAtNonFinal: false,
    moreAvailable: false,
    error: null,
    cursor: { lastLt: start.lastLt, lastHash: start.lastHash },
  }
  let lastGood: { lt: bigint; hash: string } | null = null

  try {
    let offset = 0
    let page = 0
    pages: while (true) {
      const rows = await ton.getTransactions({
        account,
        ...(start.lastLt > 0n ? { startLt: start.lastLt } : {}),
        sort: 'asc',
        limit: deps.batchLimit,
        offset,
      })
      summary.fetched += rows.length

      for (const row of rows) {
        const lt = BigInt(row.lt)
        const hash = normalizeHash(row.hash)
        // `start_lt` is inclusive: the row the cursor points at comes back and is skipped.
        if (lt < start.lastLt || (lt === start.lastLt && hash === start.lastHash)) continue
        if (!isFinal(row)) {
          summary.stoppedAtNonFinal = true
          break pages
        }
        const classification = classifyTransaction(row, deps.ctx)
        if (classification.kind === 'skip') {
          summary.skipped += 1
          log.debug({ account, lt: row.lt, why: classification.why }, 'scan: skipped row')
        } else {
          const result = await apply(db, toPaymentEvent(row, classification, account), {
            touchCursor: true,
            now: deps.now(),
          })
          if (result.duplicate) {
            summary.duplicates += 1
          } else {
            summary.applied += 1
            log.info(
              {
                account,
                lt: row.lt,
                hash,
                status: result.status,
                reason: result.reason,
                orderId: result.orderId,
              },
              'scan: payment recorded',
            )
          }
        }
        lastGood = { lt, hash }
      }

      if (rows.length < deps.batchLimit) break
      page += 1
      if (page >= maxPages || deps.signal?.aborted) {
        summary.moreAvailable = true
        break
      }
      offset += rows.length
    }
  } catch (error) {
    // The failing row was rolled back; the cursor stays on the last good one, so the same
    // row is retried on the next poll and nothing after it is processed out of order.
    summary.error = errorMessage(error)
    log.error({ err: error, account, lastGood }, 'scan: batch aborted')
  }

  const now = deps.now()
  if (lastGood) {
    await advanceCursor(db, account, lastGood.lt, lastGood.hash, now)
    summary.cursor = { lastLt: lastGood.lt, lastHash: lastGood.hash }
  }
  await db
    .update(scanCursors)
    .set({ lastPolledAt: now, lastError: summary.error, updatedAt: now })
    .where(eq(scanCursors.account, account))
  return summary
}

/**
 * Safety net for indexer lag: re-reads the last `windowSec` of history between the
 * registration floor (`start_lt`, exclusive) and the cursor (`last_lt`, inclusive) and settles
 * anything the cursor scan did not record. Duplicates are the expected outcome; the cursor is
 * never moved from here, and history before the worker's first start stays out of the ledger.
 */
export async function rescanRecentOnce(
  deps: ScannerDeps,
  target: ScanAccount,
  windowSec: number,
): Promise<RescanSummary> {
  const { db, ton, log } = deps
  const apply = deps.apply ?? applyPayment
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES
  const account = target.account
  const cursor = await readCursor(db, account)
  const summary: RescanSummary = { account, fetched: 0, recovered: 0, duplicates: 0, error: null }
  const since = Math.floor(deps.now().getTime() / 1000) - windowSec

  try {
    let offset = 0
    for (let page = 0; page < maxPages; page += 1) {
      if (deps.signal?.aborted) break
      const rows = await ton.getTransactions({
        account,
        startUtime: since,
        // Rows above the cursor belong to the regular scan; do not even fetch them.
        endLt: cursor.lastLt,
        sort: 'asc',
        limit: deps.batchLimit,
        offset,
      })
      summary.fetched += rows.length
      for (const row of rows) {
        const lt = BigInt(row.lt)
        if (lt <= cursor.startLt || lt > cursor.lastLt) continue
        if (!isFinal(row)) continue
        const classification = classifyTransaction(row, deps.ctx)
        if (classification.kind === 'skip') continue
        const result = await apply(db, toPaymentEvent(row, classification, account), {
          touchCursor: false,
          now: deps.now(),
        })
        if (result.duplicate) {
          summary.duplicates += 1
        } else {
          summary.recovered += 1
          log.warn(
            { account, lt: row.lt, status: result.status, reason: result.reason },
            'rescan: recorded a transaction the cursor scan had missed',
          )
        }
      }
      if (rows.length < deps.batchLimit) break
      offset += rows.length
    }
  } catch (error) {
    summary.error = errorMessage(error)
    log.error({ err: error, account }, 'rescan: aborted')
  }
  return summary
}
