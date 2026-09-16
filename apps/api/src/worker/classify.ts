import { isOrderId, normalizeComment } from '@tma/shared'
import {
  OP_JETTON_EXCESSES,
  OP_JETTON_INTERNAL_TRANSFER,
  OP_JETTON_TRANSFER_NOTIFICATION,
  OP_TEXT_COMMENT,
  cellFromBase64,
  parseInternalTransferBody,
  parseOpcode,
  parseTextComment,
  parseTransferNotificationBody,
} from '@tma/shared/ton'
import type { Cell } from '@ton/core'

import { toRawAddress, tryParseAddress } from '../ton/address'
import type { ToncenterMessage, ToncenterTransaction } from '../ton/toncenter.schemas'

/**
 * Pure classification of one toncenter row into "money we may credit", "money we must record
 * but cannot credit" and "nothing to do". Bodies are parsed from the raw BoC, never from the
 * indexer's decoded fields. The rules mirror how TON actually delivers value:
 *
 * - The merchant's main wallet receives TON directly. A jetton transfer only produces a
 *   `transfer_notification` here, carried by 1 nanoTON that is usually not enough to run the
 *   wallet code (`aborted`, no_gas), so USDT is never credited from this account.
 * - The merchant's jetton wallet receives `internal_transfer` from the payer's jetton wallet;
 *   a successful (non-aborted) one is the only proof that jettons were credited. The wallet
 *   contract itself rejects a sender that is not a sibling wallet of the same master, which is
 *   why a successful internal_transfer is trusted without re-deriving the sender's address.
 */

export type PaymentReason =
  | 'order_not_found'
  | 'no_comment'
  | 'currency_mismatch'
  | 'order_already_paid'
  | 'order_cancelled'
  | 'aborted_nonbounceable'
  | 'from_master'
  | 'unsupported_asset'
  | 'unknown_layout'
  | 'manual'

export type IgnoreReason = Extract<
  PaymentReason,
  'from_master' | 'unsupported_asset' | 'unknown_layout'
>

export interface ClassifyContext {
  /** Merchant main wallet, raw form. */
  merchantRaw: string
  /** Merchant jetton wallet for the accepted jetton, raw form; null when USDT is disabled. */
  merchantJettonWalletRaw: string | null
  usdtMasterRaw: string | null
  /** TON transfers without a usable comment below this value are dust and are not recorded. */
  minRecordNano: bigint
}

export interface TonCandidate {
  kind: 'candidate'
  currency: 'TON'
  jettonMaster: null
  amount: bigint
  sender: string | null
  comment: string | null
  /** Value credited although the transaction aborted (non-bounceable transfer to an uninitialised wallet). */
  abortedNonBounceable: boolean
}

export interface UsdtCandidate {
  kind: 'candidate'
  currency: 'USDT'
  jettonMaster: string
  amount: bigint
  /** Owner wallet that sent the jettons (from the internal_transfer body). */
  sender: string | null
  comment: string | null
  abortedNonBounceable: false
}

export type Candidate = TonCandidate | UsdtCandidate

export interface Ignored {
  kind: 'ignored'
  reason: IgnoreReason
  currency: 'TON' | 'USDT' | null
  jettonMaster: string | null
  /** The contract that sent the message; for a foreign jetton this is where a refund goes. */
  sourceWallet: string | null
  amount: bigint
  sender: string | null
  comment: string | null
}

export type SkipReason =
  | 'unknown_account'
  | 'no_in_msg'
  | 'external'
  | 'bounced'
  | 'bounced_back'
  | 'own_jetton_notification'
  | 'excesses'
  | 'internal_transfer_on_wallet'
  | 'dust'
  | 'failed'
  | 'not_incoming_jettons'

export interface Skipped {
  kind: 'skip'
  why: SkipReason
}

export type Classification = Candidate | Ignored | Skipped

const skip = (why: SkipReason): Skipped => ({ kind: 'skip', why })

function rawOf(value: string | null | undefined): string | null {
  if (!value) return null
  return tryParseAddress(value)?.raw ?? null
}

function digits(value: string | null | undefined): bigint {
  return value && /^\d+$/.test(value) ? BigInt(value) : 0n
}

function bodyOf(msg: ToncenterMessage): Cell | null {
  const boc = msg.message_content?.body
  return boc ? cellFromBase64(boc) : null
}

/** True for a comment that could name an order after normalisation. */
export function isUsableComment(comment: string | null): boolean {
  return comment !== null && isOrderId(normalizeComment(comment))
}

function classifyMainWallet(
  tx: ToncenterTransaction,
  msg: ToncenterMessage,
  source: string,
  ctx: ClassifyContext,
): Classification {
  if (msg.bounced === true) return skip('bounced')
  const aborted = tx.description?.aborted === true
  // A bounceable message whose transaction aborted was returned to the sender. Only an
  // explicit `bounce: false` proves the value stayed; an unknown flag fails closed.
  if (aborted && msg.bounce !== false) return skip('bounced_back')

  const value = digits(msg.value)
  const body = bodyOf(msg)
  const opcode = parseOpcode(body)

  if (opcode === null || opcode === OP_TEXT_COMMENT) {
    if (body !== null && body.bits.length > 0 && opcode === null) {
      // Fewer than 32 bits: not a text comment and not empty. Nothing we can interpret.
      if (value < ctx.minRecordNano) return skip('dust')
      return ignoredTon('unknown_layout', value, source)
    }
    const comment = opcode === OP_TEXT_COMMENT ? parseTextComment(body) : null
    if (!isUsableComment(comment) && value < ctx.minRecordNano) return skip('dust')
    return {
      kind: 'candidate',
      currency: 'TON',
      jettonMaster: null,
      amount: value,
      sender: source,
      comment,
      abortedNonBounceable: aborted,
    }
  }

  if (opcode === OP_JETTON_EXCESSES) return skip('excesses')

  if (opcode === OP_JETTON_TRANSFER_NOTIFICATION) {
    // The accepted jetton was already credited on the jetton wallet scan; every other
    // notification is a token we do not sell, kept for a manual refund.
    if (ctx.merchantJettonWalletRaw !== null && source === ctx.merchantJettonWalletRaw) {
      return skip('own_jetton_notification')
    }
    const notify = parseTransferNotificationBody(body)
    return {
      kind: 'ignored',
      reason: 'unsupported_asset',
      currency: null,
      jettonMaster: null,
      sourceWallet: source,
      amount: notify?.amount ?? 0n,
      sender: notify?.sender ? toRawAddress(notify.sender) : null,
      comment: notify?.comment ?? null,
    }
  }

  // Only jetton wallets receive internal_transfer; on a plain wallet it is noise.
  if (opcode === OP_JETTON_INTERNAL_TRANSFER) return skip('internal_transfer_on_wallet')

  if (value < ctx.minRecordNano) return skip('dust')
  return ignoredTon('unknown_layout', value, source)
}

function ignoredTon(reason: IgnoreReason, amount: bigint, sender: string): Ignored {
  return {
    kind: 'ignored',
    reason,
    currency: 'TON',
    jettonMaster: null,
    sourceWallet: null,
    amount,
    sender,
    comment: null,
  }
}

function classifyJettonWallet(
  tx: ToncenterTransaction,
  msg: ToncenterMessage,
  source: string,
  ctx: ClassifyContext,
): Classification {
  const master = ctx.usdtMasterRaw
  if (master === null) return skip('unknown_account')
  if (msg.bounced === true) return skip('bounced')

  const body = bodyOf(msg)
  if (parseOpcode(body) !== OP_JETTON_INTERNAL_TRANSFER) return skip('not_incoming_jettons')

  // Jettons are credited only when the whole transaction succeeded. `aborted` is the
  // authoritative flag; the phase flags are required in addition and fail closed when absent.
  const descr = tx.description
  const succeeded =
    descr?.aborted === false &&
    descr.compute_ph?.success === true &&
    descr.action?.success !== false
  if (!succeeded) return skip('failed')

  const parsed = parseInternalTransferBody(body)
  const sender = parsed?.from ? toRawAddress(parsed.from) : null

  if (source === master) {
    // A mint from the master is not a customer payment.
    return {
      kind: 'ignored',
      reason: 'from_master',
      currency: 'USDT',
      jettonMaster: master,
      sourceWallet: source,
      amount: parsed?.amount ?? 0n,
      sender,
      comment: parsed?.comment ?? null,
    }
  }
  if (!parsed) {
    return {
      kind: 'ignored',
      reason: 'unknown_layout',
      currency: 'USDT',
      jettonMaster: master,
      sourceWallet: source,
      amount: 0n,
      sender: null,
      comment: null,
    }
  }
  return {
    kind: 'candidate',
    currency: 'USDT',
    jettonMaster: master,
    amount: parsed.amount,
    sender,
    comment: parsed.comment,
    abortedNonBounceable: false,
  }
}

export function classifyTransaction(
  tx: ToncenterTransaction,
  ctx: ClassifyContext,
): Classification {
  const account = rawOf(tx.account)
  const isMain = account !== null && account === ctx.merchantRaw
  const isJetton =
    account !== null &&
    ctx.merchantJettonWalletRaw !== null &&
    account === ctx.merchantJettonWalletRaw
  if (!isMain && !isJetton) return skip('unknown_account')

  const msg = tx.in_msg
  // Tick-tock and similar system transactions carry `in_msg: {}`.
  if (!msg || Object.keys(msg).length === 0) return skip('no_in_msg')
  const source = rawOf(msg.source)
  // External messages (the owner's own outgoing transfers) have no source.
  if (source === null) return skip('external')

  return isMain
    ? classifyMainWallet(tx, msg, source, ctx)
    : classifyJettonWallet(tx, msg, source, ctx)
}
