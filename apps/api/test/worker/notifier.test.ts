import { notifications, orders, users, type Db, type DbHandle } from '@tma/db'
import { createTestDb, truncateAll } from '@tma/db/testing'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createBotApi, type BotApi } from '../../src/telegram/bot-api'
import {
  NOTIFY_BACKOFF_MAX_MS,
  NOTIFY_MAX_ATTEMPTS,
  notifyOnce,
  retryDelayMs,
  type NotifierDeps,
} from '../../src/worker/notifier'
import { seedProduct } from '../helpers/auth'
import { testEnv, testShop } from '../helpers/build-app'
import {
  errorResponse,
  okResponse,
  startFakeBotApi,
  type FakeBotApi,
} from '../helpers/fake-bot-api'

const USER_ID = 42n
const ORDER_IDS = ['0123456789abcdef', '0123456789abcdeg', '0123456789abcdeh'] as const
const now = new Date('2026-09-16T12:00:00Z')
const log = pino({ level: 'silent' })

let clock = now
let handle: DbHandle
let fake: FakeBotApi
let botApi: BotApi

beforeAll(async () => {
  handle = createTestDb()
  fake = await startFakeBotApi()
  botApi = createBotApi({ token: '123456:TEST', baseUrl: fake.url, testDc: false })
})

afterAll(async () => {
  await fake.close()
  await handle.close()
})

beforeEach(async () => {
  await truncateAll(handle.db)
  fake.requests.length = 0
  fake.onRequest = undefined
  clock = now
})

interface SeedOptions {
  orderId?: string
  languageCode?: string | null
  deliveryPayload?: string | null
  deliverInChat?: boolean
  nextAttemptAt?: Date
  claimedAt?: Date | null
  attempts?: number
  status?: 'pending' | 'sent' | 'failed'
}

/** User + product + paid order + one pending notification; returns the notification id. */
async function seedNotification(options: SeedOptions = {}): Promise<string> {
  const orderId = options.orderId ?? ORDER_IDS[0]
  await handle.db
    .insert(users)
    .values({ telegramId: USER_ID, firstName: 'Test', languageCode: options.languageCode ?? 'en' })
    .onConflictDoNothing()
  const product = await seedProduct(handle.db, {
    slug: `guide-${orderId}`,
    title: 'TON Guide',
    deliveryPayload: options.deliveryPayload ?? 'https://example.com/download',
    deliverInChat: options.deliverInChat ?? false,
  })
  await handle.db.insert(orders).values({
    id: orderId,
    userId: USER_ID,
    productId: product.id,
    productTitle: product.title,
    currency: 'TON',
    amount: 1n,
    merchantAddress: '0:AA',
    status: 'paid',
    paidAt: now,
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    createdAt: now,
    updatedAt: now,
  })
  const [row] = await handle.db
    .insert(notifications)
    .values({
      orderId,
      telegramUserId: USER_ID,
      status: options.status ?? 'pending',
      attempts: options.attempts ?? 0,
      nextAttemptAt: options.nextAttemptAt ?? now,
      claimedAt: options.claimedAt ?? null,
      createdAt: now,
    })
    .returning({ id: notifications.id })
  if (!row) throw new Error('notification not inserted')
  return row.id
}

async function load(id: string, db: Db = handle.db) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id))
  if (!row) throw new Error(`notification ${id} not found`)
  return row
}

function run(overrides: Partial<NotifierDeps> = {}) {
  return notifyOnce({
    db: handle.db,
    botApi,
    shop: testShop(),
    env: testEnv(),
    now: () => clock,
    log,
    ...overrides,
  })
}

function lastBody(): Record<string, unknown> {
  return fake.requests.at(-1)?.body as Record<string, unknown>
}

describe('claiming', () => {
  it('claims a due row: claimed_at set and attempts incremented once', async () => {
    const id = await seedNotification()
    const result = await run()
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, deferred: 0 })
    const row = await load(id)
    expect(row.claimedAt).toEqual(now)
    expect(row.attempts).toBe(1)
  })

  it('does nothing when no row is due', async () => {
    await seedNotification({ nextAttemptAt: new Date(now.getTime() + 1000) })
    expect(await run()).toEqual({ claimed: 0, sent: 0, failed: 0, deferred: 0 })
    expect(fake.requests).toHaveLength(0)
  })

  it('re-claims a stale claim but not a recent one', async () => {
    const stale = await seedNotification({
      orderId: ORDER_IDS[0],
      claimedAt: new Date(now.getTime() - 6 * 60_000),
    })
    const recent = await seedNotification({
      orderId: ORDER_IDS[1],
      claimedAt: new Date(now.getTime() - 60_000),
    })
    const result = await run()
    expect(result.claimed).toBe(1)
    expect(fake.requests).toHaveLength(1)
    expect((await load(stale)).status).toBe('sent')
    const untouched = await load(recent)
    expect(untouched.status).toBe('pending')
    expect(untouched.attempts).toBe(0)
  })

  it('commits the claim before calling Telegram', async () => {
    const id = await seedNotification()
    let observed: { claimedAt: Date | null; attempts: number; status: string } | null = null
    fake.onRequest = async () => {
      // A second pool sees only committed state; the claim must already be visible here.
      const other = createTestDb()
      try {
        const row = await load(id, other.db)
        observed = { claimedAt: row.claimedAt, attempts: row.attempts, status: row.status }
      } finally {
        await other.close()
      }
    }
    await run()
    expect(observed).toEqual({ claimedAt: now, attempts: 1, status: 'pending' })
  })

  it('splits the work between two concurrent workers without duplicates', async () => {
    const ids: string[] = []
    for (const orderId of ORDER_IDS) ids.push(await seedNotification({ orderId }))
    const other = createTestDb()
    try {
      const [a, b] = await Promise.all([run(), run({ db: other.db })])
      expect(a.claimed + b.claimed).toBe(3)
      expect(a.sent + b.sent).toBe(3)
    } finally {
      await other.close()
    }
    expect(fake.requests).toHaveLength(3)
    for (const id of ids) {
      const row = await load(id)
      expect(row.status).toBe('sent')
      expect(row.attempts).toBe(1)
    }
  })
})

describe('message content', () => {
  it('sends plain text with the product title and order id', async () => {
    await seedNotification()
    await run()
    const body = lastBody()
    expect(body.chat_id).toBe(USER_ID.toString())
    expect(body.text).toContain('TON Guide')
    expect(body.text).toContain(ORDER_IDS[0])
    expect(body).not.toHaveProperty('parse_mode')
  })

  it('reveals the payload and protects the message when the product opts in', async () => {
    await seedNotification({ deliveryPayload: 'KEY-123', deliverInChat: true })
    await run()
    const body = lastBody()
    expect((body.text as string).endsWith('\n\nKEY-123')).toBe(true)
    expect(body.protect_content).toBe(true)
  })

  it('keeps the payload out of the chat otherwise', async () => {
    await seedNotification({ deliveryPayload: 'KEY-123', deliverInChat: false })
    await run()
    const body = lastBody()
    expect(body.text).not.toContain('KEY-123')
    expect(body).not.toHaveProperty('protect_content')
  })

  it('adds the open button only when the deep link can be built', async () => {
    await seedNotification()
    await run({
      env: testEnv({ TELEGRAM_BOT_USERNAME: 'my_shop_bot', TELEGRAM_MINIAPP_SHORT_NAME: 'shop' }),
    })
    expect(lastBody().reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: 'Open order',
            url: `https://t.me/my_shop_bot/shop?startapp=order_${ORDER_IDS[0]}`,
          },
        ],
      ],
    })

    await truncateAll(handle.db)
    await seedNotification()
    await run({ env: testEnv() })
    expect(lastBody()).not.toHaveProperty('reply_markup')
  })
})

describe('outcomes', () => {
  it('marks a delivered row as sent with the Telegram message id', async () => {
    const id = await seedNotification()
    fake.enqueue(okResponse(777))
    await run()
    const row = await load(id)
    expect(row.status).toBe('sent')
    expect(row.telegramMessageId).toBe(777n)
    expect(row.sentAt).toEqual(now)
    expect(row.lastError).toBeNull()
  })

  it('fails permanently on 403 and never asks again', async () => {
    const id = await seedNotification()
    fake.enqueue(errorResponse(403, 'Forbidden: bot was blocked by the user'))
    expect(await run()).toMatchObject({ failed: 1 })
    const row = await load(id)
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('403')

    clock = new Date(now.getTime() + NOTIFY_BACKOFF_MAX_MS)
    expect(await run()).toMatchObject({ claimed: 0 })
    expect(fake.requests).toHaveLength(1)
  })

  it('fails permanently on 400 chat not found', async () => {
    const id = await seedNotification()
    fake.enqueue(errorResponse(400, 'Bad Request: chat not found'))
    await run()
    expect((await load(id)).status).toBe('failed')
  })

  it('waits exactly retry_after on 429 and gives the attempt back', async () => {
    const id = await seedNotification()
    fake.enqueue(errorResponse(429, 'Too Many Requests: retry after 7', { retry_after: 7 }))
    expect(await run()).toMatchObject({ deferred: 1 })
    const row = await load(id)
    expect(row.status).toBe('pending')
    expect(row.nextAttemptAt).toEqual(new Date(now.getTime() + 7000))
    expect(row.attempts).toBe(0)
    expect(row.claimedAt).toBeNull()
    expect(row.lastError).toContain('429')
  })

  it('backs off exponentially after a 500 and retries when due', async () => {
    const id = await seedNotification()
    fake.enqueue(errorResponse(500, 'Internal Server Error'))
    await run()
    let row = await load(id)
    expect(row.status).toBe('pending')
    expect(row.nextAttemptAt).toEqual(new Date(now.getTime() + 5000))
    expect(row.claimedAt).toBeNull()
    expect(row.attempts).toBe(1)

    // Not due yet: nothing happens.
    clock = new Date(now.getTime() + 4000)
    expect(await run()).toMatchObject({ claimed: 0 })
    expect(fake.requests).toHaveLength(1)

    clock = new Date(now.getTime() + 6000)
    fake.enqueue(errorResponse(500, 'Internal Server Error'))
    await run()
    expect(fake.requests).toHaveLength(2)
    row = await load(id)
    expect(row.attempts).toBe(2)
    expect(row.nextAttemptAt).toEqual(new Date(clock.getTime() + 10_000))
  })

  it('follows the 5 s … 10 min ladder', () => {
    const seconds = Array.from({ length: 12 }, (_, i) => retryDelayMs(i + 1) / 1000)
    expect(seconds).toEqual([5, 10, 20, 40, 80, 160, 320, 600, 600, 600, 600, 600])
  })

  it('gives up after the maximum number of attempts', async () => {
    const id = await seedNotification()
    for (let attempt = 1; attempt <= NOTIFY_MAX_ATTEMPTS; attempt += 1) {
      fake.enqueue(errorResponse(500, 'Internal Server Error'))
      const result = await run()
      expect(result.claimed).toBe(1)
      clock = new Date(clock.getTime() + retryDelayMs(attempt) + 1000)
    }
    const row = await load(id)
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(NOTIFY_MAX_ATTEMPTS)
    expect(row.lastError).toContain('500')
    expect(fake.requests).toHaveLength(NOTIFY_MAX_ATTEMPTS)

    fake.enqueue(errorResponse(500, 'Internal Server Error'))
    expect(await run()).toMatchObject({ claimed: 0 })
    expect(fake.requests).toHaveLength(NOTIFY_MAX_ATTEMPTS)
  })
})
