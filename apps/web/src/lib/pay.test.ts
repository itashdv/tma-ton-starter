import { TonConnectUIError, UserRejectsError, WalletWrongNetworkError } from '@tonconnect/ui-react'
import { describe, expect, it, vi } from 'vitest'

import { payWithWallet } from './pay'
import type { SendTransactionRequestLike } from './tonconnect'

const request: SendTransactionRequestLike = {
  validUntil: 1_700_000_300,
  network: '-3',
  from: '0:abc',
  messages: [{ address: '0QAB', amount: '1', payload: 'te6cckEB' }],
}

describe('payWithWallet', () => {
  it('returns the boc when the wallet signed', async () => {
    const sendTransaction = vi.fn(async () => ({ boc: 'te6ccsigned' }))
    const outcome = await payWithWallet({ sendTransaction }, request)
    expect(outcome).toEqual({ kind: 'sent', boc: 'te6ccsigned' })
    expect(sendTransaction).toHaveBeenCalledWith(request)
  })

  it('treats a user rejection as a normal outcome', async () => {
    const outcome = await payWithWallet(
      {
        sendTransaction: async () => {
          throw new UserRejectsError()
        },
      },
      request,
    )
    expect(outcome).toEqual({ kind: 'declined' })
  })

  it('reports a wrong network with both chains', async () => {
    const error = new WalletWrongNetworkError('wrong network', {
      cause: { expectedChainId: '-239', actualChainId: '-3' },
    })
    const outcome = await payWithWallet(
      {
        sendTransaction: async () => {
          throw error
        },
      },
      request,
    )
    // expectedChainId is where the wallet is; actualChainId is what the request asked for.
    expect(outcome).toEqual({ kind: 'wrong_network', walletChain: '-239', requestedChain: '-3' })
  })

  it('reports a disconnected wallet', async () => {
    const outcome = await payWithWallet(
      {
        sendTransaction: async () => {
          throw new TonConnectUIError('Connect wallet to send a transaction.')
        },
      },
      request,
    )
    expect(outcome).toEqual({ kind: 'not_connected' })
  })

  it('treats a closed confirmation modal as a rejection, not as a disconnected wallet', async () => {
    // The UI throws the same class when the user dismisses the "confirm in your wallet" modal.
    const outcome = await payWithWallet(
      {
        sendTransaction: async () => {
          throw new TonConnectUIError('Transaction was not sent')
        },
      },
      request,
    )
    expect(outcome).toEqual({ kind: 'declined' })
  })

  it('reports anything else as a failure without leaking an exception', async () => {
    const outcome = await payWithWallet(
      {
        sendTransaction: async () => {
          throw new Error('bridge unreachable')
        },
      },
      request,
    )
    expect(outcome).toEqual({ kind: 'failed', message: 'bridge unreachable' })
  })
})
