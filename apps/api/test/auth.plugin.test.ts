import { users } from '@tma/db'
import { truncateAll } from '@tma/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import pino from 'pino'

import { buildApp, defaultLogger } from '../src/app'
import { signInitData, signMockInitData } from '../src/auth/sign-init-data'
import { buildTestApp, testEnv, testShop, type TestApp } from './helpers/build-app'
import { TEST_BOT_TOKEN, authHeader } from './helpers/auth'

let t: TestApp
const now = new Date('2026-09-16T12:00:00Z')
const nowSec = Math.floor(now.getTime() / 1000)

beforeAll(async () => {
  t = buildTestApp({ now: () => now })
  await t.app.ready()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await truncateAll(t.handle.db)
})

function get(headers: Record<string, string> = {}) {
  return t.app.inject({ method: 'GET', url: '/me', headers })
}

describe('requireTma', () => {
  it('rejects a missing or foreign authorization scheme', async () => {
    expect((await get()).json()).toMatchObject({ error: { code: 'initdata_missing' } })
    expect((await get()).statusCode).toBe(401)
    const bearer = await get({ authorization: 'Bearer token' })
    expect(bearer.statusCode).toBe(401)
    expect(bearer.json()).toMatchObject({ error: { code: 'initdata_missing' } })
    const empty = await get({ authorization: 'tma' })
    expect(empty.json()).toMatchObject({ error: { code: 'initdata_missing' } })
  })

  it('rejects forged init data', async () => {
    const response = await get({
      authorization: 'tma user=%7B%22id%22%3A1%7D&hash=' + 'a'.repeat(64),
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'initdata_invalid' } })
  })

  it('accepts valid init data and upserts the Telegram profile', async () => {
    const response = await get({
      authorization: authHeader({
        id: 42,
        username: 'buyer',
        authDate: nowSec,
        allowsWriteToPm: true,
      }),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      user: { id: '42', username: 'buyer', allowsWriteToPm: true },
      isAdmin: false,
      network: 'testnet',
      tonNetworkId: '-3',
      currencies: ['TON', 'USDT'],
    })

    const [row] = await t.handle.db.select().from(users).where(eq(users.telegramId, 42n))
    expect(row?.username).toBe('buyer')
    expect(row?.allowsWriteToPm).toBe(true)
    expect(row?.lastSeenAt.toISOString()).toBe(now.toISOString())
  })

  it('refreshes a changed profile and the last seen time on the next call', async () => {
    await get({ authorization: authHeader({ id: 42, username: 'old', authDate: nowSec }) })
    const [before] = await t.handle.db.select().from(users)

    // A second app with a later clock: last_seen_at must move, not stay at the first launch.
    const later = new Date(now.getTime() + 60_000)
    const app = buildTestApp({ now: () => later }, t.handle)
    await app.app.ready()
    try {
      await app.app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: authHeader({ id: 42, username: 'new', authDate: nowSec }) },
      })
    } finally {
      await app.app.close()
    }

    const rows = await t.handle.db.select().from(users)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.username).toBe('new')
    expect(rows[0]?.lastSeenAt.toISOString()).toBe(later.toISOString())
    expect(rows[0]?.lastSeenAt.getTime()).toBeGreaterThan(before?.lastSeenAt.getTime() ?? 0)
    // The creation time must not move.
    expect(rows[0]?.createdAt.toISOString()).toBe(before?.createdAt.toISOString())
  })

  it('reports expired init data separately from invalid', async () => {
    const stale = authHeader({ id: 42, authDate: nowSec - 3601 })
    const response = await get({ authorization: stale })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'initdata_expired' } })
  })

  it('reports init data without a user', async () => {
    const raw = signInitData({ auth_date: nowSec, query_id: 'AAE' }, TEST_BOT_TOKEN)
    expect((await get({ authorization: `tma ${raw}` })).json()).toMatchObject({
      error: { code: 'user_missing' },
    })
  })

  it('does not accept data signed with another bot token', async () => {
    const other = signMockInitData('999999:OTHER', { authDate: nowSec })
    expect((await get({ authorization: `tma ${other}` })).json()).toMatchObject({
      error: { code: 'initdata_invalid' },
    })
  })
})

describe('admin identification', () => {
  it('is false for everyone when TELEGRAM_ADMIN_IDS is empty', async () => {
    const response = await get({ authorization: authHeader({ id: 42, authDate: nowSec }) })
    expect(response.json<{ isAdmin: boolean }>().isAdmin).toBe(false)
  })

  it('is true only for the configured ids', async () => {
    const admin = buildTestApp(
      { env: testEnv({ TELEGRAM_ADMIN_IDS: '42, 77' }), now: () => now },
      t.handle,
    )
    await admin.app.ready()
    try {
      const asAdmin = await admin.app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: authHeader({ id: 42, authDate: nowSec }) },
      })
      expect(asAdmin.json<{ isAdmin: boolean }>().isAdmin).toBe(true)
      const asUser = await admin.app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: authHeader({ id: 43, authDate: nowSec }) },
      })
      expect(asUser.json<{ isAdmin: boolean }>().isAdmin).toBe(false)
    } finally {
      await admin.app.close()
    }
  })
})

describe('logging', () => {
  it('never writes the init data credential to the log', async () => {
    const env = testEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      CORS_ORIGINS: 'https://shop.example.com',
      TONCENTER_API_KEY: 'key',
    })
    const lines: string[] = []
    const logger = pino(
      { ...(defaultLogger(env) as pino.LoggerOptions) },
      { write: (line: string) => lines.push(line) },
    )
    const app = buildApp(
      { env, db: t.handle.db, shop: testShop(), now: () => now },
      { loggerInstance: logger },
    )
    await app.ready()
    const raw = signMockInitData(TEST_BOT_TOKEN, { id: 42, authDate: nowSec })
    try {
      // A serializer that does include the headers must still hit the redaction path.
      logger.info({ req: { headers: { authorization: `tma ${raw}` } } }, 'incoming')
      await app.inject({ method: 'GET', url: '/me', headers: { authorization: `tma ${raw}` } })
      await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'tma broken' } })
    } finally {
      await app.close()
    }
    const output = lines.join('\n')
    expect(output.length).toBeGreaterThan(0)
    expect(output).toContain('[Redacted]')
    // The raw string is replayable until it expires, so it must never appear anywhere.
    expect(output).not.toContain(raw)
    expect(output).not.toContain(raw.slice(0, 40))
  })
})
