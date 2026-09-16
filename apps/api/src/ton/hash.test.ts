import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { hashToBase64, normalizeHash } from './hash'

describe('normalizeHash', () => {
  it('accepts hex, base64 and base64url and returns lowercase hex', () => {
    const bytes = randomBytes(32)
    const hex = bytes.toString('hex')
    expect(normalizeHash(hex)).toBe(hex)
    expect(normalizeHash(hex.toUpperCase())).toBe(hex)
    expect(normalizeHash(bytes.toString('base64'))).toBe(hex)
    expect(normalizeHash(bytes.toString('base64url'))).toBe(hex)
  })

  it('handles base64 containing + and /', () => {
    const withSpecials = 'PvU+DXisBC/Ig3qLRuLdlEtnRLTxqZUGCCiGIpBMIPQ='
    expect(normalizeHash(withSpecials)).toBe(Buffer.from(withSpecials, 'base64').toString('hex'))
  })

  it('rejects anything that is not 32 bytes', () => {
    for (const bad of ['', 'abc', 'z'.repeat(64), randomBytes(31).toString('base64')]) {
      expect(() => normalizeHash(bad), bad).toThrow()
    }
  })
})

describe('hashToBase64', () => {
  it('round-trips with normalizeHash', () => {
    const hex = randomBytes(32).toString('hex')
    expect(normalizeHash(hashToBase64(hex))).toBe(hex)
    expect(() => hashToBase64('nope')).toThrow()
  })
})
