import type { Address } from '@ton/core'
import type { PaymentInstructionsDto, TonConnectMessageDto } from '@tma/shared'
import { bocToBase64, buildCommentCell, buildJettonTransferBody } from '@tma/shared/ton'

import type { Env } from '../env'
import { toFriendly } from '../ton/address'

/**
 * The wallet receives exactly what the API built. The browser adds only validUntil, the
 * network id and the sender address, so a client cannot change the destination or the amount.
 */

export interface TonPaymentInput {
  currency: 'TON'
  orderId: string
  amount: bigint
  merchant: Address
}

export interface JettonPaymentInput {
  currency: 'USDT'
  orderId: string
  amount: bigint
  merchant: Address
  payer: Address
  /** Jetton wallet of the payer: the transfer message goes there, not to the merchant. */
  payerJettonWallet: Address
  jettonMaster: Address
}

export type PaymentInput = TonPaymentInput | JettonPaymentInput

export interface BuildInstructionsOptions {
  env: Pick<
    Env,
    | 'tonNetworkId'
    | 'isTestnet'
    | 'JETTON_TRANSFER_ATTACH_NANO'
    | 'JETTON_FORWARD_NANO'
    | 'TX_VALID_SECONDS'
  >
  expiresAt: Date
  /** Random query id correlating transfer, notification and excesses of one jetton transfer. */
  queryId?: bigint
}

export function buildPaymentInstructions(
  input: PaymentInput,
  options: BuildInstructionsOptions,
): PaymentInstructionsDto {
  const { env } = options
  const comment = buildCommentCell(input.orderId)
  const messages: TonConnectMessageDto[] = []

  if (input.currency === 'TON') {
    messages.push({
      // Non-bounceable: a plain wallet that is not deployed yet would bounce the payment back.
      address: toFriendly(input.merchant, { bounceable: false, testOnly: env.isTestnet }),
      amount: input.amount.toString(),
      payload: bocToBase64(comment),
    })
  } else {
    const body = buildJettonTransferBody({
      queryId: options.queryId ?? 0n,
      amount: input.amount,
      destination: input.merchant,
      responseDestination: input.payer,
      forwardTonAmount: env.JETTON_FORWARD_NANO,
      forwardPayload: comment,
    })
    messages.push({
      // The payer's jetton wallet is a contract: bounceable, so a failed transfer returns.
      address: toFriendly(input.payerJettonWallet, { bounceable: true, testOnly: env.isTestnet }),
      amount: env.JETTON_TRANSFER_ATTACH_NANO.toString(),
      payload: bocToBase64(body),
    })
  }

  return {
    network: env.tonNetworkId,
    comment: input.orderId,
    messages,
    expiresAt: options.expiresAt.toISOString(),
    validSeconds: env.TX_VALID_SECONDS,
    jettonMaster: input.currency === 'USDT' ? input.jettonMaster.toRawString() : null,
  }
}
