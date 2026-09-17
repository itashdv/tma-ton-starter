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

/* ---------------------------------------------------------------------------------------- */
/* Admin API (`/admin/*`, TELEGRAM_ADMIN_IDS only). Amounts are digit strings, ids are strings. */

export type PaymentStatusDto = 'matched' | 'underpaid' | 'unmatched' | 'ignored'
export type NotificationStatusDto = 'pending' | 'sent' | 'failed'
export type ScanCursorLabelDto = 'ton_wallet' | 'usdt_jetton_wallet'

/** Catalogue row as the administrator sees it: inactive products and the payload included. */
export interface AdminProductDto extends ProductDto {
  deliveryPayload: string | null
  deliverInChat: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Body of `POST /admin/products`. Prices are already in the smallest units (nanoTON,
 * 10^-decimals of the jetton): the browser converts the decimal string the admin typed.
 */
export interface AdminProductInput {
  slug: string
  title: string
  description?: string
  imageUrl?: string | null
  priceTonNano?: string | null
  priceUsdtUnits?: string | null
  deliveryPayload?: string | null
  deliverInChat?: boolean
  isActive?: boolean
  sortOrder?: number
}

/** Body of `PATCH /admin/products/:id`: only the listed fields change; `null` clears a field. */
export type AdminProductPatch = Partial<AdminProductInput>

export interface AdminOrderDto extends OrderDto {
  userId: string
  userFirstName: string | null
  userUsername: string | null
  jettonMaster: string | null
  merchantAddress: string
  payerAddress: string | null
  extMsgHash: string | null
  cancelledAt: string | null
  cancelledBy: string | null
  adminNote: string | null
  updatedAt: string
}

export interface AdminPaymentDto {
  id: string
  account: string
  txHash: string
  txLt: string
  txNow: string
  mcBlockSeqno: string
  traceId: string | null
  currency: OrderCurrency | null
  jettonMaster: string | null
  sourceWallet: string | null
  amount: string
  senderAddress: string | null
  comment: string | null
  orderId: string | null
  status: PaymentStatusDto
  reason: string | null
  payerMismatch: boolean
  attachedBy: string | null
  createdAt: string
  /** Explorer link for the transaction on the configured network. */
  tonviewerUrl: string
  /** Explorer link for the sender wallet, when the sender is known. */
  senderUrl: string | null
}

export interface AdminNotificationDto {
  id: string
  orderId: string
  kind: string
  telegramUserId: string
  status: NotificationStatusDto
  attempts: number
  nextAttemptAt: string
  claimedAt: string | null
  sentAt: string | null
  telegramMessageId: string | null
  lastError: string | null
  createdAt: string
}

export interface AdminOrderDetailsDto {
  order: AdminOrderDto
  payments: AdminPaymentDto[]
  notifications: AdminNotificationDto[]
}

/** Keyset page: pass `nextCursor` back as `?cursor=` to continue; null means the end. */
export interface AdminOrdersPageDto {
  orders: AdminOrderDto[]
  nextCursor: string | null
}

export interface AdminPaymentsPageDto {
  payments: AdminPaymentDto[]
  nextCursor: string | null
}

export interface AdminAttachInput {
  orderId: string
  /** Accept an underpayment. A currency mismatch is never accepted. */
  force?: boolean
}

export interface AdminAttachResponse {
  payment: AdminPaymentDto
  order: AdminOrderDto
}

export interface AdminCursorDto {
  account: string
  /** Friendly form of `account` for display and explorer links. */
  address: string
  url: string
  label: ScanCursorLabelDto
  startLt: string
  lastLt: string
  lastHash: string | null
  lastPolledAt: string | null
  /** Seconds since the last poll; null when the account was never polled. */
  lagSeconds: number | null
  stale: boolean
  lastError: string | null
  updatedAt: string
}

export interface AdminHealthDto {
  now: string
  network: 'mainnet' | 'testnet'
  pollMs: number
  merchant: { raw: string; address: string; url: string }
  usdtMaster: { raw: string; address: string; url: string } | null
  worker: HealthResponse['worker']
  cursors: AdminCursorDto[]
  counts: {
    unmatchedPayments: number
    underpaidPayments: number
    ignoredPayments: number
    failedNotifications: number
    pendingNotifications: number
    pendingOrders: number
    paidOrders: number
  }
}
