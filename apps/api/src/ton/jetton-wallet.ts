import type { Address } from '@ton/core'

import type { ToncenterClient } from './toncenter'

/**
 * The payer's jetton wallet address is deterministic, so it is resolved once per (master,
 * owner) and cached for the process lifetime. Without the cache every checkout would spend a
 * toncenter request from a 1 rps budget.
 */
export interface JettonWalletResolver {
  resolve: (master: Address, owner: Address) => Promise<Address>
  size: () => number
  /** Drops every cached address; used by tests and by an admin-triggered refresh. */
  clear: () => void
}

export function createJettonWalletResolver(ton: ToncenterClient): JettonWalletResolver {
  const cache = new Map<string, Promise<Address>>()
  return {
    resolve(master, owner) {
      const key = `${master.toRawString()}:${owner.toRawString()}`
      const cached = cache.get(key)
      if (cached) return cached
      const pending = ton.getJettonWalletAddress(master, owner).catch((error: unknown) => {
        // Never cache a failure: the next checkout must retry.
        cache.delete(key)
        throw error
      })
      cache.set(key, pending)
      return pending
    },
    size: () => cache.size,
    clear: () => cache.clear(),
  }
}
