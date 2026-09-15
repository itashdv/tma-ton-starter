import { describe, expect, it } from 'vitest'

import {
  ORDER_ID_RANDOM_BYTES,
  ORDER_ID_RE,
  generateOrderId,
  isOrderId,
  normalizeComment,
} from './order-id'

describe('generateOrderId', () => {
  it('produces 16 lowercase Crockford base32 characters', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateOrderId()).toMatch(ORDER_ID_RE)
    }
  })

  it('asks the random source for exactly 10 bytes and uses all 80 bits', () => {
    const calls: number[] = []
    const allZero = generateOrderId((n) => {
      calls.push(n)
      return new Uint8Array(n)
    })
    expect(calls).toEqual([ORDER_ID_RANDOM_BYTES])
    expect(allZero).toBe('0000000000000000')
    const allOnes = generateOrderId((n) => new Uint8Array(n).fill(0xff))
    expect(allOnes).toBe('zzzzzzzzzzzzzzzz')
    const lastBit = generateOrderId((n) => {
      const bytes = new Uint8Array(n)
      bytes[n - 1] = 1
      return bytes
    })
    expect(lastBit).toBe('0000000000000001')
  })

  it('does not repeat across 10 000 ids', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(generateOrderId())
    }
    expect(seen.size).toBe(10_000)
  })

  it('rejects a random source of the wrong length', () => {
    expect(() => generateOrderId(() => new Uint8Array(4))).toThrow()
  })
})

describe('isOrderId', () => {
  it('accepts only the canonical form', () => {
    expect(isOrderId('0123456789abcdef')).toBe(true)
    expect(isOrderId('zzzzzzzzzzzzzzzz')).toBe(true)
    expect(isOrderId('0123456789ABCDEF')).toBe(false)
    expect(isOrderId('0123456789abcde')).toBe(false)
    expect(isOrderId('0123456789abcdefg')).toBe(false)
    expect(isOrderId(' 0123456789abcdef')).toBe(false)
    expect(isOrderId('0123456789abcdef ')).toBe(false)
    expect(isOrderId(123)).toBe(false)
    expect(isOrderId(null)).toBe(false)
    for (const excluded of ['i', 'l', 'o', 'u']) {
      expect(isOrderId(`${excluded}123456789abcdef`), excluded).toBe(false)
    }
  })
})

describe('normalizeComment', () => {
  it('trims and lowercases', () => {
    expect(normalizeComment('  0123456789ABCDEF \n')).toBe('0123456789abcdef')
    expect(isOrderId(normalizeComment(' 0123456789ABCDEF '))).toBe(true)
  })
})
