import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Money and logical time are bigint columns (Postgres int8 ↔ JS bigint). Addresses are stored
 * raw (`wc:HEX`, uppercase, as toncenter returns them); hashes are lowercase hex.
 */

export const currencyEnum = pgEnum('currency', ['TON', 'USDT'])
export const orderStatusEnum = pgEnum('order_status', ['pending', 'paid', 'expired', 'cancelled'])
export const paymentStatusEnum = pgEnum('payment_status', [
  'matched',
  'underpaid',
  'unmatched',
  'ignored',
])
export const notificationStatusEnum = pgEnum('notification_status', ['pending', 'sent', 'failed'])

export type Currency = (typeof currencyEnum.enumValues)[number]
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number]
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number]
export type NotificationStatus = (typeof notificationStatusEnum.enumValues)[number]

const money = (name: string) => bigint(name, { mode: 'bigint' })
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const users = pgTable('users', {
  telegramId: bigint('telegram_id', { mode: 'bigint' }).primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name'),
  username: text('username'),
  languageCode: text('language_code'),
  photoUrl: text('photo_url'),
  isPremium: boolean('is_premium').notNull().default(false),
  allowsWriteToPm: boolean('allows_write_to_pm').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
})

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Seed key: config/products.json is matched to rows by slug. */
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    imageUrl: text('image_url'),
    priceTonNano: money('price_ton_nano'),
    /** In 10^-decimals units, decimals come from config/shop.json (usdt.decimals). */
    priceUsdtUnits: money('price_usdt_units'),
    deliveryPayload: text('delivery_payload'),
    deliverInChat: boolean('deliver_in_chat').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('products_active_sort_idx').on(t.isActive, t.sortOrder),
    check('products_price_ton_positive', sql`${t.priceTonNano} IS NULL OR ${t.priceTonNano} > 0`),
    check(
      'products_price_usdt_positive',
      sql`${t.priceUsdtUnits} IS NULL OR ${t.priceUsdtUnits} > 0`,
    ),
    check(
      'products_has_price',
      sql`${t.priceTonNano} IS NOT NULL OR ${t.priceUsdtUnits} IS NOT NULL`,
    ),
  ],
)

export const orders = pgTable(
  'orders',
  {
    /** 16 lowercase Crockford base32 chars; this exact string is the on-chain payment comment. */
    id: text('id').primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.telegramId),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    productTitle: text('product_title').notNull(),
    currency: currencyEnum('currency').notNull(),
    /** nanoTON for TON, smallest jetton units for USDT — snapshot taken at creation. */
    amount: money('amount').notNull(),
    jettonMaster: text('jetton_master'),
    merchantAddress: text('merchant_address').notNull(),
    payerAddress: text('payer_address'),
    payerJettonWallet: text('payer_jetton_wallet'),
    status: orderStatusEnum('status').notNull().default('pending'),
    submittedAt: ts('submitted_at'),
    /** TEP-467 normalized hash of the external message returned by the wallet. UX only. */
    extMsgHash: text('ext_msg_hash'),
    paidLate: boolean('paid_late').notNull().default(false),
    expiresAt: ts('expires_at').notNull(),
    paidAt: ts('paid_at'),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: bigint('cancelled_by', { mode: 'bigint' }),
    adminNote: text('admin_note'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('orders_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('orders_status_expires_idx').on(t.status, t.expiresAt),
    check('orders_id_format', sql`${t.id} ~ '^[0-9a-hjkmnp-tv-z]{16}$'`),
    check('orders_amount_positive', sql`${t.amount} > 0`),
    check('orders_usdt_has_master', sql`${t.currency} <> 'USDT' OR ${t.jettonMaster} IS NOT NULL`),
  ],
)

/** Append-only ledger of everything seen on the merchant accounts, including ignored rows. */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Scanned account (raw) on which the transaction happened. */
    account: text('account').notNull(),
    /** Transaction hash on the merchant side, lowercase hex. */
    txHash: text('tx_hash').notNull().unique(),
    txLt: bigint('tx_lt', { mode: 'bigint' }).notNull(),
    txNow: ts('tx_now').notNull(),
    mcBlockSeqno: bigint('mc_block_seqno', { mode: 'bigint' }).notNull(),
    traceId: text('trace_id'),
    /** NULL for ignored rows without an identifiable asset. */
    currency: currencyEnum('currency'),
    jettonMaster: text('jetton_master'),
    /** Foreign jetton wallet that sent an unsupported asset (for manual refunds). */
    sourceWallet: text('source_wallet'),
    amount: money('amount').notNull(),
    senderAddress: text('sender_address'),
    /** Comment exactly as received on-chain, before normalisation. */
    comment: text('comment'),
    orderId: text('order_id').references(() => orders.id),
    status: paymentStatusEnum('status').notNull(),
    reason: text('reason'),
    payerMismatch: boolean('payer_mismatch').notNull().default(false),
    attachedBy: bigint('attached_by', { mode: 'bigint' }),
    /** The toncenter row, kept verbatim for audits. */
    raw: jsonb('raw').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_account_lt_uq').on(t.account, t.txLt),
    uniqueIndex('payments_one_matched_per_order')
      .on(t.orderId)
      .where(sql`${t.status} = 'matched'`),
    index('payments_status_created_idx').on(t.status, t.createdAt.desc()),
    index('payments_order_idx').on(t.orderId),
    check('payments_tx_hash_hex', sql`${t.txHash} ~ '^[0-9a-f]{64}$'`),
    check('payments_amount_nonnegative', sql`${t.amount} >= 0`),
  ],
)

/** One row per scanned account: where the worker resumes and when it last polled. */
export const SCAN_CURSOR_LABELS = ['ton_wallet', 'usdt_jetton_wallet'] as const
export type ScanCursorLabel = (typeof SCAN_CURSOR_LABELS)[number]

export const scanCursors = pgTable(
  'scan_cursors',
  {
    account: text('account').primaryKey(),
    label: text('label').$type<ScanCursorLabel>().notNull(),
    /** Head of the account when the worker first saw it; nothing at or below it is ever ingested. */
    startLt: bigint('start_lt', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    lastLt: bigint('last_lt', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    lastHash: text('last_hash'),
    lastPolledAt: ts('last_polled_at'),
    lastError: text('last_error'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('scan_cursors_label_known', sql`${t.label} IN ('ton_wallet', 'usdt_jetton_wallet')`),
  ],
)

/** Transactional outbox for Bot API messages. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    kind: text('kind').notNull().default('order_paid'),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull(),
    status: notificationStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    claimedAt: ts('claimed_at'),
    sentAt: ts('sent_at'),
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notifications_order_kind_uq').on(t.orderId, t.kind),
    index('notifications_pending_next_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
  ],
)

export const ALL_TABLES = { users, products, orders, payments, scanCursors, notifications } as const
