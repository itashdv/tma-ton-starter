import { Address } from '@ton/core'

/**
 * toncenter returns raw addresses as `wc:HEX` with uppercase hex, while @ton/core produces
 * lowercase. Everything stored or compared in this project uses the toncenter form.
 */

/** `Address.parseRaw` silently truncates junk and accepts a NaN workchain, so gate it first. */
export const RAW_ADDRESS_RE = /^(0|-1):[0-9a-fA-F]{64}$/

export interface ParsedAddress {
  /** `wc:HEX` with uppercase hex. */
  raw: string
  address: Address
  /** Flags of the friendly form the value was written in; null for raw input. */
  testOnly: boolean | null
  bounceable: boolean | null
}

export function toRawAddress(address: Address): string {
  const [wc, hex] = address.toRawString().split(':')
  return `${wc}:${(hex ?? '').toUpperCase()}`
}

export function parseAddress(value: string): ParsedAddress {
  if (Address.isFriendly(value)) {
    const parsed = Address.parseFriendly(value)
    return {
      raw: toRawAddress(parsed.address),
      address: parsed.address,
      testOnly: parsed.isTestOnly,
      bounceable: parsed.isBounceable,
    }
  }
  if (!RAW_ADDRESS_RE.test(value)) {
    throw new Error(`invalid raw address "${value}": expected <0|-1>:<64 hex chars>`)
  }
  const address = Address.parseRaw(value)
  return { raw: toRawAddress(address), address, testOnly: null, bounceable: null }
}

export function tryParseAddress(value: string): ParsedAddress | null {
  try {
    return parseAddress(value)
  } catch {
    return null
  }
}

/** Compares two addresses in any form; invalid input is never equal to anything. */
export function addressesEqual(a: string, b: string): boolean {
  const left = tryParseAddress(a)
  const right = tryParseAddress(b)
  return left !== null && right !== null && left.raw === right.raw
}

export interface FriendlyOptions {
  /** Smart-contract destinations are bounceable; plain wallets are not. */
  bounceable: boolean
  testOnly: boolean
}

export function toFriendly(address: Address, options: FriendlyOptions): string {
  return address.toString({
    urlSafe: true,
    bounceable: options.bounceable,
    testOnly: options.testOnly,
  })
}
