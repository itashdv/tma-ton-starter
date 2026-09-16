import type { Address, Cell } from '@ton/core'
import { beginCell } from '@ton/core'

/**
 * Message bodies the Mini App asks a wallet to send. They are built on the server so that the
 * browser never needs @ton/core and never decides an amount or a destination.
 */

export const OP_TEXT_COMMENT = 0x00000000
export const OP_JETTON_TRANSFER = 0x0f8a7ea5
export const OP_JETTON_TRANSFER_NOTIFICATION = 0x7362d09c
export const OP_JETTON_INTERNAL_TRANSFER = 0x178d4519
export const OP_JETTON_EXCESSES = 0xd53276db

/** A cell holds 1023 bits; after the 32-bit opcode 123 whole bytes fit without a reference. */
export const MAX_INLINE_COMMENT_BYTES = 123

/** Text comment: 32 zero bits followed by UTF-8 text (snake format when it does not fit). */
export function buildCommentCell(comment: string): Cell {
  return beginCell().storeUint(OP_TEXT_COMMENT, 32).storeStringTail(comment).endCell()
}

export interface JettonTransferParams {
  /** Arbitrary; correlates transfer, notification and excesses of one transfer. */
  queryId: bigint
  /** Jetton amount in the smallest units. */
  amount: bigint
  /** Owner address of the recipient (the merchant wallet), not its jetton wallet. */
  destination: Address
  /** Where leftover TON goes: the payer. */
  responseDestination: Address
  /** Must be > 0, otherwise the merchant wallet never receives a notification. */
  forwardTonAmount: bigint
  /** Carried to the recipient inside the notification; the order id comment. */
  forwardPayload?: Cell | null
}

/**
 * TEP-74 `transfer`, sent to the PAYER's jetton wallet. The forward payload is stored as a
 * reference (the Either right form): the body is already ~640 bits, so an inline comment
 * would overflow the root cell.
 */
export function buildJettonTransferBody(params: JettonTransferParams): Cell {
  const builder = beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(params.queryId, 64)
    .storeCoins(params.amount)
    .storeAddress(params.destination)
    .storeAddress(params.responseDestination)
    .storeMaybeRef(null) // custom_payload
    .storeCoins(params.forwardTonAmount)
  if (params.forwardPayload) {
    builder.storeBit(1).storeRef(params.forwardPayload)
  } else {
    builder.storeBit(0)
  }
  return builder.endCell()
}

export function bocToBase64(cell: Cell): string {
  return cell.toBoc().toString('base64')
}
