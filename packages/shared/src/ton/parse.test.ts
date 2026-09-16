import { Address, beginCell } from '@ton/core'
import { describe, expect, it } from 'vitest'

import {
  cellFromBase64,
  parseInternalTransferBody,
  parseOpcode,
  parseTextComment,
  parseTransferNotificationBody,
} from './parse'
import {
  OP_JETTON_INTERNAL_TRANSFER,
  OP_JETTON_TRANSFER_NOTIFICATION,
  buildCommentCell,
} from './payload'

const OWNER = Address.parse('UQAREREREREREREREREREREREREREREREREREREREREREbvW')
const ORDER_ID = '0123456789abcdef'

function internalTransfer(options: { inlineComment?: boolean; comment?: string | null } = {}) {
  const builder = beginCell()
    .storeUint(OP_JETTON_INTERNAL_TRANSFER, 32)
    .storeUint(3n, 64)
    .storeCoins(5_000_000n)
    .storeAddress(OWNER)
    .storeAddress(OWNER)
    .storeCoins(1n)
  const comment = options.comment === undefined ? ORDER_ID : options.comment
  if (comment === null) return builder.storeBit(0).endCell()
  if (options.inlineComment) {
    return builder.storeBit(0).storeUint(0, 32).storeStringTail(comment).endCell()
  }
  return builder.storeBit(1).storeRef(buildCommentCell(comment)).endCell()
}

describe('parseInternalTransferBody', () => {
  it('reads the credit event of the merchant jetton wallet', () => {
    const parsed = parseInternalTransferBody(internalTransfer())
    expect(parsed?.queryId).toBe(3n)
    expect(parsed?.amount).toBe(5_000_000n)
    expect(parsed?.from?.equals(OWNER)).toBe(true)
    expect(parsed?.forwardTonAmount).toBe(1n)
    expect(parsed?.comment).toBe(ORDER_ID)
  })

  it('reads a comment stored inline as well as in a reference', () => {
    expect(parseInternalTransferBody(internalTransfer({ inlineComment: true }))?.comment).toBe(
      ORDER_ID,
    )
    expect(parseInternalTransferBody(internalTransfer({ comment: null }))?.comment).toBeNull()
  })

  it('reassembles a snake comment longer than one cell', () => {
    const long = 'z'.repeat(400)
    expect(parseInternalTransferBody(internalTransfer({ comment: long }))?.comment).toBe(long)
  })

  it('returns null for a truncated or foreign body', () => {
    expect(
      parseInternalTransferBody(beginCell().storeUint(OP_JETTON_INTERNAL_TRANSFER, 32).endCell()),
    ).toBeNull()
    expect(parseInternalTransferBody(buildCommentCell('hi'))).toBeNull()
    expect(parseInternalTransferBody(beginCell().endCell())).toBeNull()
    expect(parseInternalTransferBody(null)).toBeNull()
  })
})

describe('parseTransferNotificationBody', () => {
  const notification = beginCell()
    .storeUint(OP_JETTON_TRANSFER_NOTIFICATION, 32)
    .storeUint(9n, 64)
    .storeCoins(750_000n)
    .storeAddress(OWNER)
    .storeBit(1)
    .storeRef(buildCommentCell(ORDER_ID))
    .endCell()

  it('reads amount, sender and comment', () => {
    const parsed = parseTransferNotificationBody(notification)
    expect(parsed?.queryId).toBe(9n)
    expect(parsed?.amount).toBe(750_000n)
    expect(parsed?.sender?.equals(OWNER)).toBe(true)
    expect(parsed?.comment).toBe(ORDER_ID)
  })

  it('returns null for a body that is not a notification', () => {
    expect(parseTransferNotificationBody(internalTransfer())).toBeNull()
    expect(
      parseTransferNotificationBody(
        beginCell().storeUint(OP_JETTON_TRANSFER_NOTIFICATION, 32).endCell(),
      ),
    ).toBeNull()
  })
})

describe('parseTextComment / parseOpcode / cellFromBase64', () => {
  it('handles empty and malformed input without throwing', () => {
    expect(parseTextComment(beginCell().endCell())).toBeNull()
    expect(parseTextComment(null)).toBeNull()
    expect(parseOpcode(beginCell().endCell())).toBeNull()
    expect(parseOpcode(null)).toBeNull()
    expect(cellFromBase64('not-a-boc')).toBeNull()
    expect(cellFromBase64('')).toBeNull()
  })

  it('ignores a body whose first 32 bits are not the text opcode', () => {
    expect(
      parseTextComment(beginCell().storeUint(0x2167da4b, 32).storeStringTail('x').endCell()),
    ).toBeNull()
  })
})
