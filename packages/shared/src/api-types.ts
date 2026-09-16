/** Shapes shared between apps/api and apps/web. Amounts travel as digit strings. */

export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}

export interface HealthResponse {
  ok: boolean
  db: 'up' | 'down'
  version: string
  worker: {
    lastPollAt: string | null
    ageSec: number | null
    stale: boolean
  }
}

export interface ProductDto {
  id: string
  slug: string
  title: string
  description: string
  imageUrl: string | null
  priceTonNano: string | null
  priceUsdtUnits: string | null
  sortOrder: number
}

export interface MeUserDto {
  id: string
  firstName: string
  lastName: string | null
  username: string | null
  languageCode: string | null
  photoUrl: string | null
  isPremium: boolean
  allowsWriteToPm: boolean
}

export interface MeResponse {
  user: MeUserDto
  isAdmin: boolean
  network: 'mainnet' | 'testnet'
  tonNetworkId: string
  botUsername: string | null
  miniAppShortName: string | null
  currencies: ('TON' | 'USDT')[]
}

export type OrderCurrency = 'TON' | 'USDT'
export type OrderStatusDto = 'pending' | 'paid' | 'expired' | 'cancelled'

export interface OrderDto {
  id: string
  status: OrderStatusDto
  currency: OrderCurrency
  /** Smallest units: nanoTON for TON, 10^-decimals for the jetton. */
  amount: string
  productId: string
  productTitle: string
  createdAt: string
  expiresAt: string
  paidAt: string | null
  paidLate: boolean
  submittedAt: string | null
  /** Only present once the order is paid. */
  delivery: { payload: string | null; deliverInChat: boolean } | null
}

/** A TonConnect message, ready to be passed to the wallet without modification. */
export interface TonConnectMessageDto {
  address: string
  amount: string
  payload: string
}

export interface PaymentInstructionsDto {
  /** TonConnect network id: "-239" mainnet, "-3" testnet. */
  network: string
  /** The on-chain comment that identifies the order; equal to the order id. */
  comment: string
  messages: TonConnectMessageDto[]
  /** ISO timestamp after which the order expires server-side. */
  expiresAt: string
  /** Seconds the wallet request stays valid; the client computes validUntil from it. */
  validSeconds: number
  jettonMaster: string | null
}

export interface CreateOrderResponse {
  order: OrderDto
  payment: PaymentInstructionsDto
}
