/**
 * toncenter returns transaction and message hashes as standard base64 (with `+` and `/`),
 * while query parameters and our database use lowercase hex. Everything is normalised here.
 */

const HEX_64 = /^[0-9a-fA-F]{64}$/
const BASE64_44 = /^[A-Za-z0-9+/_-]{43}=?$/

export function normalizeHash(value: string): string {
  const trimmed = value.trim()
  if (HEX_64.test(trimmed)) return trimmed.toLowerCase()
  if (BASE64_44.test(trimmed)) {
    const buffer = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (buffer.length === 32) return buffer.toString('hex')
  }
  throw new Error(`invalid hash "${value}": expected 32 bytes as hex or base64`)
}

/** Hex hash back to the standard base64 form toncenter expects in query parameters. */
export function hashToBase64(hex: string): string {
  if (!HEX_64.test(hex)) throw new Error(`invalid hex hash "${hex}"`)
  return Buffer.from(hex, 'hex').toString('base64')
}
