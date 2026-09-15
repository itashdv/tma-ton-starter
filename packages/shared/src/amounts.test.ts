import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  AmountError,
  formatTon,
  formatUnits,
  formatUsdt,
  isDigitString,
  parseDigitString,
  parseTon,
  parseUnits,
  parseUsdt,
} from './amounts'

describe('parseUnits / parseTon / parseUsdt', () => {
  it('parses decimal strings into smallest units', () => {
    expect(parseTon('1.5')).toBe(1_500_000_000n)
    expect(parseTon('0.000000001')).toBe(1n)
    expect(parseTon('0')).toBe(0n)
    expect(parseTon('007.5')).toBe(7_500_000_000n)
    expect(parseUsdt('12.345678', 6)).toBe(12_345_678n)
    expect(parseUsdt('1.5', 9)).toBe(1_500_000_000n)
    expect(parseUsdt('1.2345678', 9)).toBe(1_234_567_800n)
    expect(parseUnits('42', 0)).toBe(42n)
  })

  it('rejects more decimal places than the asset has', () => {
    expect(() => parseUsdt('1.2345678', 6)).toThrowError(AmountError)
    try {
      parseUsdt('1.2345678', 6)
    } catch (error) {
      expect((error as AmountError).code).toBe('too_many_decimals')
    }
  })

  it('rejects everything that is not a plain decimal string', () => {
    for (const bad of ['1e3', '-1', '1,5', '', ' 1', '1 ', '.5', '5.', '+1', '0x10', 'abc']) {
      expect(() => parseTon(bad), bad).toThrowError(AmountError)
    }
  })

  it('rejects invalid decimals arguments', () => {
    expect(() => parseUnits('1', -1)).toThrowError(AmountError)
    expect(() => parseUnits('1', 19)).toThrowError(AmountError)
    expect(() => parseUnits('1', 1.5)).toThrowError(AmountError)
  })
})

describe('formatUnits / formatTon / formatUsdt', () => {
  it('formats smallest units back into decimal strings without trailing zeros', () => {
    expect(formatTon(1n)).toBe('0.000000001')
    expect(formatTon(1_500_000_000n)).toBe('1.5')
    expect(formatTon(0n)).toBe('0')
    expect(formatUnits(12_000_000n, 6)).toBe('12')
    expect(formatUnits(1_500_000_000n, 9)).toBe('1.5')
    expect(formatUsdt(9_990_000n, 6)).toBe('9.99')
    expect(formatUnits(42n, 0)).toBe('42')
  })

  it('rejects negative amounts', () => {
    expect(() => formatTon(-1n)).toThrowError(AmountError)
  })

  it('round-trips random bigints for 6 and 9 decimals', () => {
    let seed = 0x9e3779b9
    const next = () => {
      // deterministic xorshift so failures are reproducible
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return BigInt(seed >>> 0)
    }
    for (let i = 0; i < 1000; i += 1) {
      const value = (next() << 32n) | next()
      for (const decimals of [6, 9]) {
        expect(parseUnits(formatUnits(value, decimals), decimals)).toBe(value)
      }
    }
  })
})

describe('digit strings (wire format)', () => {
  it('accepts only ASCII digit strings', () => {
    expect(isDigitString('0')).toBe(true)
    expect(isDigitString('1500000000')).toBe(true)
    expect(isDigitString('')).toBe(false)
    expect(isDigitString('1.5')).toBe(false)
    expect(isDigitString('-1')).toBe(false)
    expect(isDigitString(15)).toBe(false)
    expect(parseDigitString('1500000000')).toBe(1_500_000_000n)
    expect(() => parseDigitString('1.5')).toThrowError(AmountError)
  })
})

describe('implementation guard', () => {
  it('never touches floating point', () => {
    const source = readFileSync(new URL('./amounts.ts', import.meta.url), 'utf8')
    for (const forbidden of ['Number(', 'parseFloat', 'parseInt', '.toFixed', 'Math.']) {
      expect(source.includes(forbidden), forbidden).toBe(false)
    }
  })
})
