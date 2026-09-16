import { describe, expect, it } from 'vitest'

import { isFinal } from './finality'

const final = { finality: 'finalized', emulated: false, mc_block_seqno: 92_816_994 }

describe('isFinal', () => {
  it('accepts a finalized, observed row that sits in a masterchain block', () => {
    expect(isFinal(final)).toBe(true)
    expect(isFinal({ ...final, finality: 2 })).toBe(true) // integer enum form of the schema
  })

  it('rejects confirmed and pending rows', () => {
    expect(isFinal({ ...final, finality: 'confirmed' })).toBe(false)
    expect(isFinal({ ...final, finality: 'pending' })).toBe(false)
    expect(isFinal({ ...final, finality: null })).toBe(false)
    expect(isFinal({ ...final, finality: undefined })).toBe(false)
  })

  it('rejects emulated rows, including when the flag is missing', () => {
    expect(isFinal({ ...final, emulated: true })).toBe(false)
    expect(isFinal({ ...final, emulated: null })).toBe(false)
    expect(isFinal({ ...final, emulated: undefined })).toBe(false)
  })

  it('rejects rows without a masterchain block', () => {
    expect(isFinal({ ...final, mc_block_seqno: null })).toBe(false)
    expect(isFinal({ ...final, mc_block_seqno: undefined })).toBe(false)
  })
})
