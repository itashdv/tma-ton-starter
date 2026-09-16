import { Address, beginCell } from '@ton/core'
import { describe, expect, it } from 'vitest'

import {
  MAX_INLINE_COMMENT_BYTES,
  OP_JETTON_TRANSFER,
  bocToBase64,
  buildCommentCell,
  buildJettonTransferBody,
} from './payload'
import { cellFromBase64, parseJettonTransferBody, parseOpcode, parseTextComment } from './parse'

const MERCHANT = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')
const PAYER = Address.parse('UQAREREREREREREREREREREREREREREREREREREREREREbvW')
const ORDER_ID = '0123456789abcdef'

describe('buildCommentCell', () => {
  it('writes 32 zero bits and the text, and parses back', () => {
    const cell = buildCommentCell(ORDER_ID)
    expect(cell.refs.length).toBe(0)
    expect(parseOpcode(cell)).toBe(0)
    expect(parseTextComment(cell)).toBe(ORDER_ID)
  })

  it('keeps up to 123 bytes in the root cell and spills into a reference after that', () => {
    expect(buildCommentCell('x'.repeat(MAX_INLINE_COMMENT_BYTES)).refs.length).toBe(0)
    expect(buildCommentCell('x'.repeat(MAX_INLINE_COMMENT_BYTES + 1)).refs.length).toBe(1)
    const long = 'y'.repeat(300)
    expect(parseTextComment(buildCommentCell(long))).toBe(long)
  })

  it('survives a base64 round trip', () => {
    const base64 = bocToBase64(buildCommentCell(ORDER_ID))
    expect(base64.startsWith('te6cc')).toBe(true)
    expect(parseTextComment(cellFromBase64(base64))).toBe(ORDER_ID)
  })
})

describe('buildJettonTransferBody', () => {
  const body = buildJettonTransferBody({
    queryId: 7n,
    amount: 12_345_678n,
    destination: MERCHANT,
    responseDestination: PAYER,
    forwardTonAmount: 1n,
    forwardPayload: buildCommentCell(ORDER_ID),
  })

  it('builds a TEP-74 transfer whose comment travels in a referenced forward payload', () => {
    expect(parseOpcode(body)).toBe(OP_JETTON_TRANSFER)
    expect(body.bits.length).toBeLessThanOrEqual(1023)
    expect(body.refs.length).toBe(1)

    const parsed = parseJettonTransferBody(body)
    expect(parsed).not.toBeNull()
    expect(parsed?.queryId).toBe(7n)
    expect(parsed?.amount).toBe(12_345_678n)
    expect(parsed?.destination.equals(MERCHANT)).toBe(true)
    expect(parsed?.responseDestination?.equals(PAYER)).toBe(true)
    expect(parsed?.forwardTonAmount).toBe(1n)
    expect(parsed?.comment).toBe(ORDER_ID)
  })

  it('works without a forward payload', () => {
    const plain = buildJettonTransferBody({
      queryId: 0n,
      amount: 1n,
      destination: MERCHANT,
      responseDestination: PAYER,
      forwardTonAmount: 0n,
    })
    expect(plain.refs.length).toBe(0)
    expect(parseJettonTransferBody(plain)?.comment).toBeNull()
  })

  it('returns null for bodies that are not a jetton transfer', () => {
    expect(parseJettonTransferBody(buildCommentCell('hi'))).toBeNull()
    expect(parseJettonTransferBody(beginCell().endCell())).toBeNull()
    expect(parseJettonTransferBody(null)).toBeNull()
  })
})
