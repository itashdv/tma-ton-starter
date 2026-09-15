/**
 * Money is always an integer amount of the smallest unit (nanoTON, 10^-decimals of a jetton)
 * held in a bigint. Conversions to and from decimal strings are done with string arithmetic
 * only: no floating point anywhere in this module.
 */

export type AmountErrorCode = 'invalid_format' | 'too_many_decimals' | 'invalid_decimals'

export class AmountError extends Error {
  readonly code: AmountErrorCode

  constructor(code: AmountErrorCode, message: string) {
    super(message)
    this.name = 'AmountError'
    this.code = code
  }
}

export const TON_DECIMALS = 9
export const MAX_DECIMALS = 18

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/
const DIGITS_RE = /^\d+$/

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountError('invalid_decimals', `decimals must be an integer in 0..${MAX_DECIMALS}`)
  }
}

/** `"1.5"` with 9 decimals → `1500000000n`. Rejects signs, exponents, commas and blanks. */
export function parseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals)
  const match = DECIMAL_RE.exec(value)
  if (!match) {
    throw new AmountError('invalid_format', `invalid amount "${value}"`)
  }
  const whole = match[1] ?? '0'
  const fraction = match[2] ?? ''
  if (fraction.length > decimals) {
    throw new AmountError(
      'too_many_decimals',
      `amount "${value}" has more than ${decimals} decimal places`,
    )
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}

/** `1500000000n` with 9 decimals → `"1.5"`. Trailing zeros are trimmed, no exponent form. */
export function formatUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals)
  if (value < 0n) {
    throw new AmountError('invalid_format', 'negative amounts are not supported')
  }
  const digits = value.toString()
  if (decimals === 0) return digits
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole
}

export function parseTon(value: string): bigint {
  return parseUnits(value, TON_DECIMALS)
}

export function formatTon(nano: bigint): string {
  return formatUnits(nano, TON_DECIMALS)
}

export function parseUsdt(value: string, decimals: number): bigint {
  return parseUnits(value, decimals)
}

export function formatUsdt(units: bigint, decimals: number): string {
  return formatUnits(units, decimals)
}

/** True for a non-empty string of ASCII digits: the wire format of every amount in the API. */
export function isDigitString(value: unknown): value is string {
  return typeof value === 'string' && DIGITS_RE.test(value)
}

/** Parses an API amount (`"1500000000"`) into a bigint; throws on anything else. */
export function parseDigitString(value: string): bigint {
  if (!isDigitString(value)) {
    throw new AmountError('invalid_format', `expected a digit string, got "${value}"`)
  }
  return BigInt(value)
}
