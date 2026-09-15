/**
 * Order ids double as the on-chain payment comment, so they must be short, unguessable and
 * wallet-friendly: 16 lowercase Crockford base32 characters (80 random bits). The alphabet
 * excludes i, l, o and u to avoid look-alike characters when a user types the comment by hand.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export const ORDER_ID_LENGTH = 16
export const ORDER_ID_RANDOM_BYTES = 10
export const ORDER_ID_RE = /^[0-9a-hjkmnp-tv-z]{16}$/

export type RandomBytes = (length: number) => Uint8Array

function webCryptoRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function generateOrderId(random: RandomBytes = webCryptoRandom): string {
  const bytes = random(ORDER_ID_RANDOM_BYTES)
  if (bytes.length !== ORDER_ID_RANDOM_BYTES) {
    throw new Error(
      `random source returned ${bytes.length} bytes, expected ${ORDER_ID_RANDOM_BYTES}`,
    )
  }
  let acc = 0n
  for (const byte of bytes) {
    acc = (acc << 8n) | BigInt(byte)
  }
  let id = ''
  for (let i = ORDER_ID_LENGTH - 1; i >= 0; i -= 1) {
    const index = Number((acc >> BigInt(i * 5)) & 31n)
    id += ALPHABET[index]
  }
  return id
}

export function isOrderId(value: unknown): value is string {
  return typeof value === 'string' && ORDER_ID_RE.test(value)
}

/** Normalises a comment received on-chain before matching it against orders.id. */
export function normalizeComment(raw: string): string {
  return raw.trim().toLowerCase()
}
