import type { PaymentInstructionsDto } from '@tma/shared'

/**
 * The wallet request is the server's payment instructions plus the three fields only the
 * client knows: how long the request stays valid, which network it is for and who sends it.
 * Nothing else is touched, so the destination and the amount cannot be changed here.
 */

export interface SendTransactionRequestLike {
  validUntil: number
  network: string
  from: string
  messages: { address: string; amount: string; payload: string }[]
}

export interface BuildRequestInput {
  payment: PaymentInstructionsDto
  /** Raw address of the connected wallet (`0:<hex>`), as TonConnect reports it. */
  walletAddress: string
  nowMs?: number
}

export function buildSendTransactionRequest(input: BuildRequestInput): SendTransactionRequestLike {
  const { payment } = input
  if (payment.messages.length === 0) {
    throw new Error('payment instructions carry no messages')
  }
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const expiresSec = Math.floor(new Date(payment.expiresAt).getTime() / 1000)
  // The TonConnect SDK warns beyond 5 minutes, and a request must never outlive the order.
  const validUntil = Math.min(nowSec + payment.validSeconds, expiresSec)
  return {
    validUntil,
    network: payment.network,
    from: input.walletAddress,
    messages: payment.messages.map((message) => ({
      address: message.address,
      amount: message.amount,
      payload: message.payload,
    })),
  }
}
