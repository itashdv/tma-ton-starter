'use client'

import { TonConnectUIError, UserRejectsError, WalletWrongNetworkError } from '@tonconnect/ui-react'

import type { SendTransactionRequestLike } from './tonconnect'

/**
 * TonConnect reports failures as error classes: their `name` is plain "Error" and they carry
 * no numeric code, so the type must be recognised with instanceof. A rejection by the user is
 * a normal outcome, not an error to show as a crash.
 */

export type PayOutcome =
  | { kind: 'sent'; boc: string }
  | { kind: 'declined' }
  | { kind: 'wrong_network'; walletChain: string | null; requestedChain: string | null }
  | { kind: 'not_connected' }
  | { kind: 'failed'; message: string }

export interface WalletLike {
  sendTransaction: (request: SendTransactionRequestLike) => Promise<{ boc: string }>
}

export async function payWithWallet(
  wallet: WalletLike,
  request: SendTransactionRequestLike,
): Promise<PayOutcome> {
  try {
    const { boc } = await wallet.sendTransaction(request)
    return { kind: 'sent', boc }
  } catch (error) {
    if (error instanceof UserRejectsError) return { kind: 'declined' }
    if (error instanceof WalletWrongNetworkError) {
      const cause = (error as { cause?: { expectedChainId?: unknown; actualChainId?: unknown } })
        .cause
      return {
        kind: 'wrong_network',
        // Verified in the SDK build: expectedChainId = wallet.account.chain and
        // actualChainId = the network of the request. The shipped .d.ts comment says the
        // opposite, so the mapping follows the code.
        walletChain: cause?.expectedChainId != null ? String(cause.expectedChainId) : null,
        requestedChain: cause?.actualChainId != null ? String(cause.actualChainId) : null,
      }
    }
    if (error instanceof TonConnectUIError) {
      // The same class covers "no wallet connected" and "the user closed the confirmation
      // modal without signing"; only the message tells them apart.
      return /not sent|aborted|cancell?ed/i.test(error.message)
        ? { kind: 'declined' }
        : { kind: 'not_connected' }
    }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
