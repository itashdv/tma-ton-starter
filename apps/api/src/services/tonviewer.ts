import type { Address } from '@ton/core'

import { toFriendly, tryParseAddress } from '../ton/address'

/**
 * Explorer links for the admin area. tonviewer has one host per network; a link built for the
 * wrong network shows "not found", which is why the network is an argument, never a default.
 */

export type TonNetwork = 'mainnet' | 'testnet'

export function tonviewerBase(network: TonNetwork): string {
  return network === 'mainnet' ? 'https://tonviewer.com' : 'https://testnet.tonviewer.com'
}

/** `hash` is the lowercase hex form stored in `payments.tx_hash`. */
export function tonviewerTransactionUrl(network: TonNetwork, hash: string): string {
  return `${tonviewerBase(network)}/transaction/${hash}`
}

export interface DisplayAddressOptions {
  /** Contracts (jetton wallets, masters) are shown bounceable; plain wallets non-bounceable. */
  contract: boolean
  network: TonNetwork
}

/** Friendly form for humans and explorer URLs, or null when the stored value is not an address. */
export function displayAddress(raw: string, options: DisplayAddressOptions): string | null {
  const parsed = tryParseAddress(raw)
  if (!parsed) return null
  return friendly(parsed.address, options)
}

export function friendly(address: Address, options: DisplayAddressOptions): string {
  return toFriendly(address, {
    bounceable: options.contract,
    testOnly: options.network === 'testnet',
  })
}

export function tonviewerAddressUrl(raw: string, options: DisplayAddressOptions): string | null {
  const address = displayAddress(raw, options)
  return address ? `${tonviewerBase(options.network)}/${address}` : null
}
