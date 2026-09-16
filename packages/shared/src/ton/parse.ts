import type { Address } from '@ton/core'
import { Cell, type Slice } from '@ton/core'

import {
  OP_JETTON_INTERNAL_TRANSFER,
  OP_JETTON_TRANSFER,
  OP_JETTON_TRANSFER_NOTIFICATION,
  OP_TEXT_COMMENT,
} from './payload'

/**
 * Bodies are parsed from the raw BoC rather than from the indexer's decoded fields: the
 * indexer only decodes plain text comments, and the listener must not depend on it.
 * Every parser returns null for a body it does not understand instead of throwing.
 */

export interface JettonTransferBody {
  queryId: bigint
  amount: bigint
  destination: Address
  responseDestination: Address | null
  forwardTonAmount: bigint
  comment: string | null
}

export interface JettonInternalTransferBody {
  queryId: bigint
  amount: bigint
  /** Owner that sent the jettons. */
  from: Address | null
  forwardTonAmount: bigint
  comment: string | null
}

export interface JettonNotificationBody {
  queryId: bigint
  amount: bigint
  /** Owner that sent the jettons. */
  sender: Address | null
  comment: string | null
}

function opcodeOf(body: Cell): number | null {
  const slice = body.beginParse()
  if (slice.remainingBits < 32) return null
  return slice.loadUint(32)
}

function readEitherComment(slice: Slice): string | null {
  // forward_payload:(Either Cell ^Cell) — the bit selects inline or referenced.
  if (slice.remainingBits < 1) return null
  const isRef = slice.loadBit()
  const payload = isRef ? (slice.remainingRefs > 0 ? slice.loadRef() : null) : null
  if (isRef) return payload ? parseTextComment(payload) : null
  return readTextComment(slice)
}

function readTextComment(slice: Slice): string | null {
  if (slice.remainingBits < 32) return null
  if (slice.loadUint(32) !== OP_TEXT_COMMENT) return null
  try {
    return slice.loadStringTail()
  } catch {
    return null
  }
}

/** Plain text comment of a TON transfer: 32 zero bits plus UTF-8 text. */
export function parseTextComment(body: Cell | null | undefined): string | null {
  if (!body) return null
  try {
    return readTextComment(body.beginParse())
  } catch {
    return null
  }
}

export function parseJettonTransferBody(body: Cell | null | undefined): JettonTransferBody | null {
  if (!body) return null
  try {
    const slice = body.beginParse()
    if (slice.remainingBits < 32 || slice.loadUint(32) !== OP_JETTON_TRANSFER) return null
    const queryId = slice.loadUintBig(64)
    const amount = slice.loadCoins()
    const destination = slice.loadAddress()
    const responseDestination = slice.loadMaybeAddress()
    slice.loadMaybeRef() // custom_payload
    const forwardTonAmount = slice.loadCoins()
    return {
      queryId,
      amount,
      destination,
      responseDestination,
      forwardTonAmount,
      comment: readEitherComment(slice),
    }
  } catch {
    return null
  }
}

/** op 0x178d4519, what the merchant jetton wallet receives: this is the credit event. */
export function parseInternalTransferBody(
  body: Cell | null | undefined,
): JettonInternalTransferBody | null {
  if (!body) return null
  try {
    const slice = body.beginParse()
    if (slice.remainingBits < 32 || slice.loadUint(32) !== OP_JETTON_INTERNAL_TRANSFER) return null
    const queryId = slice.loadUintBig(64)
    const amount = slice.loadCoins()
    const from = slice.loadMaybeAddress()
    slice.loadMaybeAddress() // response_address
    const forwardTonAmount = slice.loadCoins()
    return { queryId, amount, from, forwardTonAmount, comment: readEitherComment(slice) }
  } catch {
    return null
  }
}

/** op 0x7362d09c, what the merchant main wallet receives when forward_ton_amount > 0. */
export function parseTransferNotificationBody(
  body: Cell | null | undefined,
): JettonNotificationBody | null {
  if (!body) return null
  try {
    const slice = body.beginParse()
    if (slice.remainingBits < 32 || slice.loadUint(32) !== OP_JETTON_TRANSFER_NOTIFICATION) {
      return null
    }
    const queryId = slice.loadUintBig(64)
    const amount = slice.loadCoins()
    const sender = slice.loadMaybeAddress()
    return { queryId, amount, sender, comment: readEitherComment(slice) }
  } catch {
    return null
  }
}

/** Opcode of a body, or null when it is empty or too short (a plain transfer has none). */
export function parseOpcode(body: Cell | null | undefined): number | null {
  if (!body) return null
  try {
    return opcodeOf(body)
  } catch {
    return null
  }
}

export function cellFromBase64(boc: string): Cell | null {
  try {
    return Cell.fromBase64(boc)
  } catch {
    return null
  }
}
