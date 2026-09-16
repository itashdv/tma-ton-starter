import { Address } from '@ton/core'
import { cellFromBase64, parseJettonTransferBody, parseTextComment } from '@tma/shared/ton'
import { describe, expect, it } from 'vitest'

import { testEnv } from '../../test/helpers/build-app'
import { buildPaymentInstructions } from './payment-instructions'

const MERCHANT = Address.parseRaw(`0:${'aa'.repeat(32)}`)
const PAYER = Address.parseRaw(`0:${'bb'.repeat(32)}`)
const PAYER_JETTON_WALLET = Address.parseRaw(`0:${'cc'.repeat(32)}`)
const MASTER = Address.parseRaw(`0:${'dd'.repeat(32)}`)
const ORDER_ID = '0123456789abcdef'
const expiresAt = new Date('2026-09-16T12:30:00Z')

const MAINNET = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

function envFor(network: 'mainnet' | 'testnet') {
  return network === 'mainnet'
    ? testEnv({
        TON_NETWORK: 'mainnet',
        TONCENTER_API_KEY: 'key',
        MERCHANT_WALLET: MAINNET,
        USDT_JETTON_MASTER: MAINNET,
      })
    : testEnv()
}

describe('TON payment', () => {
  it('sends the exact amount to the merchant in non-bounceable form', () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      const env = envFor(network)
      const instructions = buildPaymentInstructions(
        { currency: 'TON', orderId: ORDER_ID, amount: 1_500_000_000n, merchant: MERCHANT },
        { env, expiresAt },
      )
      expect(instructions.network).toBe(network === 'mainnet' ? '-239' : '-3')
      expect(instructions.comment).toBe(ORDER_ID)
      expect(instructions.jettonMaster).toBeNull()
      expect(instructions.expiresAt).toBe(expiresAt.toISOString())
      expect(instructions.validSeconds).toBe(env.TX_VALID_SECONDS)

      const [message] = instructions.messages
      // A plain wallet may not be deployed yet; a bounceable transfer would come back.
      expect(message?.address.startsWith(network === 'mainnet' ? 'UQ' : '0Q'), network).toBe(true)
      expect(Address.parse(message?.address ?? '').equals(MERCHANT)).toBe(true)
      expect(message?.amount).toBe('1500000000')
      expect(message?.amount).toMatch(/^\d+$/)
      expect(parseTextComment(cellFromBase64(message?.payload ?? ''))).toBe(ORDER_ID)
    }
  })
})

describe('USDT payment', () => {
  const jettonInput = {
    currency: 'USDT' as const,
    orderId: ORDER_ID,
    amount: 5_000_000n,
    merchant: MERCHANT,
    payer: PAYER,
    payerJettonWallet: PAYER_JETTON_WALLET,
    jettonMaster: MASTER,
  }

  it('addresses the payer jetton wallet in bounceable form and pays the merchant', () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      const env = envFor(network)
      const instructions = buildPaymentInstructions(jettonInput, { env, expiresAt, queryId: 7n })
      expect(instructions.network).toBe(network === 'mainnet' ? '-239' : '-3')
      expect(instructions.jettonMaster).toBe(MASTER.toRawString())

      const [message] = instructions.messages
      // A jetton wallet is a contract: bounceable, so a failed transfer returns the jettons.
      expect(message?.address.startsWith(network === 'mainnet' ? 'EQ' : 'kQ'), network).toBe(true)
      expect(Address.parse(message?.address ?? '').equals(PAYER_JETTON_WALLET)).toBe(true)
      // The TON amount is gas for the transfer, not the price.
      expect(message?.amount).toBe(env.JETTON_TRANSFER_ATTACH_NANO.toString())
      expect(message?.amount).not.toBe('5000000')

      const body = parseJettonTransferBody(cellFromBase64(message?.payload ?? ''))
      expect(body?.queryId).toBe(7n)
      expect(body?.amount).toBe(5_000_000n)
      expect(body?.destination.equals(MERCHANT)).toBe(true)
      // Excess TON must come back to the buyer, not to the shop.
      expect(body?.responseDestination?.equals(PAYER)).toBe(true)
      expect(body?.forwardTonAmount).toBe(env.JETTON_FORWARD_NANO)
      expect(body?.forwardTonAmount).toBeGreaterThan(0n)
      expect(body?.comment).toBe(ORDER_ID)
    }
  })

  it('honours configured gas and forward amounts', () => {
    const env = testEnv({ JETTON_TRANSFER_ATTACH_NANO: '80000000', JETTON_FORWARD_NANO: '1000' })
    const instructions = buildPaymentInstructions(jettonInput, { env, expiresAt })
    expect(instructions.messages[0]?.amount).toBe('80000000')
    expect(
      parseJettonTransferBody(cellFromBase64(instructions.messages[0]?.payload ?? ''))
        ?.forwardTonAmount,
    ).toBe(1000n)
  })

  it('produces payloads the TonConnect validator accepts', () => {
    const instructions = buildPaymentInstructions(jettonInput, { env: testEnv(), expiresAt })
    for (const message of instructions.messages) {
      // base64 with padding, starting with the BoC magic, as the SDK requires.
      expect(message.payload.startsWith('te6cc')).toBe(true)
      expect(message.payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
      expect(message.address).toMatch(/^[A-Za-z0-9_-]{48}$/)
    }
  })
})
