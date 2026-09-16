import type { Cell } from '@ton/core'
import { Address, beginCell, storeMessage } from '@ton/core'
import { describe, expect, it } from 'vitest'

import { buildCommentCell } from './payload'
import { normalizedExternalMessageHash } from './ext-hash'

const WALLET = Address.parseRaw(`0:${'44'.repeat(32)}`)

function externalBoc(options: { importFee?: bigint; bodyInRef?: boolean } = {}): string {
  const body = beginCell()
    .storeUint(0x11111111, 32)
    .storeRef(buildCommentCell('0123456789abcdef'))
    .endCell()
  const message = {
    info: {
      type: 'external-in' as const,
      src: null,
      dest: WALLET,
      importFee: options.importFee ?? 0n,
    },
    body,
  }
  return beginCell()
    .store(storeMessage(message, { forceRef: options.bodyInRef ?? false }))
    .endCell()
    .toBoc()
    .toString('base64')
}

/**
 * TEP-467 written by hand from the TL-B, without storeMessage: ext_in_msg_info$10 with
 * src = addr_none$00, import_fee = 0, no state init and the body in a reference. An
 * independent construction, so a mistake in the implementation cannot hide behind itself.
 */
function normalizedByHand(dest: Address, body: Cell): string {
  return beginCell()
    .storeUint(0b10, 2) // ext_in_msg_info$10
    .storeUint(0b00, 2) // src: addr_none$00
    .storeAddress(dest)
    .storeCoins(0) // import_fee
    .storeBit(0) // no state init
    .storeBit(1) // body stored as a reference
    .storeRef(body)
    .endCell()
    .hash()
    .toString('hex')
}

describe('normalizedExternalMessageHash', () => {
  it('returns 64 lowercase hex characters', () => {
    expect(normalizedExternalMessageHash(externalBoc())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('equals the TEP-467 form built independently from the TL-B', () => {
    const body = beginCell()
      .storeUint(0x11111111, 32)
      .storeRef(buildCommentCell('0123456789abcdef'))
      .endCell()
    const expected = normalizedByHand(WALLET, body)
    // Both serialisations of the same signed message must produce that one hash.
    expect(normalizedExternalMessageHash(externalBoc({ bodyInRef: false }))).toBe(expected)
    expect(normalizedExternalMessageHash(externalBoc({ bodyInRef: true }))).toBe(expected)
    expect(normalizedExternalMessageHash(externalBoc({ importFee: 1_000_000n }))).toBe(expected)
  })

  it('is stable across serialisation differences of the same signed message', () => {
    const inline = normalizedExternalMessageHash(externalBoc({ bodyInRef: false }))
    const referenced = normalizedExternalMessageHash(externalBoc({ bodyInRef: true }))
    const withImportFee = normalizedExternalMessageHash(externalBoc({ importFee: 1_000_000n }))
    expect(referenced).toBe(inline)
    expect(withImportFee).toBe(inline)
  })

  it('differs for a different body', () => {
    const other = beginCell()
      .store(
        storeMessage({
          info: { type: 'external-in', src: null, dest: WALLET, importFee: 0n },
          body: buildCommentCell('other'),
        }),
      )
      .endCell()
      .toBoc()
      .toString('base64')
    expect(normalizedExternalMessageHash(other)).not.toBe(
      normalizedExternalMessageHash(externalBoc()),
    )
  })

  it('rejects input that is not an external-in message', () => {
    expect(() => normalizedExternalMessageHash('not-a-boc')).toThrow(/base64 BoC/)
    const internal = beginCell().storeUint(0, 32).endCell().toBoc().toString('base64')
    expect(() => normalizedExternalMessageHash(internal)).toThrow()
  })
})
