import type { PaymentInstructionsDto } from '@tma/shared'
import { describe, expect, it } from 'vitest'

import { buildSendTransactionRequest } from './tonconnect'

const nowMs = Date.parse('2026-09-16T12:00:00Z')

const payment: PaymentInstructionsDto = {
  network: '-3',
  comment: '0123456789abcdef',
  messages: [
    {
      address: '0QAREREREREREREREREREREREREREREREREREREREREREQuG',
      amount: '1500000000',
      payload: 'te6cckEB',
    },
  ],
  expiresAt: new Date(nowMs + 30 * 60_000).toISOString(),
  validSeconds: 300,
  jettonMaster: null,
}

describe('buildSendTransactionRequest', () => {
  it('passes the server messages through unchanged', () => {
    const request = buildSendTransactionRequest({ payment, walletAddress: '0:abc', nowMs })
    expect(request.messages).toEqual(payment.messages)
    expect(request.network).toBe('-3')
    expect(request.from).toBe('0:abc')
  })

  it('keeps validUntil within the wallet window and never past the order deadline', () => {
    const request = buildSendTransactionRequest({ payment, walletAddress: '0:abc', nowMs })
    expect(request.validUntil).toBe(Math.floor(nowMs / 1000) + 300)

    const almostExpired = { ...payment, expiresAt: new Date(nowMs + 60_000).toISOString() }
    const shorter = buildSendTransactionRequest({
      payment: almostExpired,
      walletAddress: '0:abc',
      nowMs,
    })
    expect(shorter.validUntil).toBe(Math.floor(nowMs / 1000) + 60)
  })

  it('uses seconds, not milliseconds', () => {
    const request = buildSendTransactionRequest({ payment, walletAddress: '0:abc', nowMs })
    expect(request.validUntil).toBeLessThan(nowMs / 100)
    expect(String(request.validUntil)).toHaveLength(10)
  })

  it('refuses instructions without messages', () => {
    expect(() =>
      buildSendTransactionRequest({
        payment: { ...payment, messages: [] },
        walletAddress: '0:abc',
        nowMs,
      }),
    ).toThrow()
  })
})
