import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  createDb,
  scanCursors,
} from '@tma/db'
import { truncateAll } from '@tma/db/testing'
import type { HealthResponse } from '@tma/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildBrokenDbApp, buildTestApp, type TestApp } from './helpers/build-app'

describe('GET /health', () => {
  let t: TestApp
  const fixedNow = new Date('2026-09-15T12:00:00Z')

  beforeAll(async () => {
    t = buildTestApp({ now: () => fixedNow })
    await t.app.ready()
  })

  afterAll(async () => {
    await t.close()
  })

  beforeEach(async () => {
    await truncateAll(t.handle.db)
  })

  it('reports db up and no worker heartbeat on a fresh database', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json<HealthResponse>()
    expect(body).toEqual({
      ok: true,
      db: 'up',
      version: 'test',
      worker: { lastPollAt: null, ageSec: null, stale: false },
    })
  })

  it('uses the oldest cursor heartbeat and flags it stale beyond 3x the poll interval', async () => {
    const fresh = new Date(fixedNow.getTime() - 2_000)
    const old = new Date(fixedNow.getTime() - 60_000)
    await t.handle.db.insert(scanCursors).values([
      { account: '0:AA', label: 'ton_wallet', lastPolledAt: fresh, updatedAt: fresh },
      { account: '0:BB', label: 'usdt_jetton_wallet', lastPolledAt: old, updatedAt: old },
    ])
    const res = await t.app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json<HealthResponse>()
    expect(body.worker).toEqual({ lastPollAt: old.toISOString(), ageSec: 60, stale: true })
  })

  it('is not stale while the oldest heartbeat is within 3x the poll interval', async () => {
    const polled = new Date(fixedNow.getTime() - 10_000)
    await t.handle.db
      .insert(scanCursors)
      .values({ account: '0:AA', label: 'ton_wallet', lastPolledAt: polled, updatedAt: polled })
    const res = await t.app.inject({ method: 'GET', url: '/health' })
    expect(res.json<HealthResponse>().worker).toEqual({
      lastPollAt: polled.toISOString(),
      ageSec: 10,
      stale: false,
    })
  })

  it('counts a cursor that never polled from its creation, so a dead scanner turns stale', async () => {
    const recent = new Date(fixedNow.getTime() - 1_000)
    const created = new Date(fixedNow.getTime() - 60_000)
    await t.handle.db.insert(scanCursors).values([
      { account: '0:AA', label: 'ton_wallet', lastPolledAt: recent, updatedAt: recent },
      { account: '0:BB', label: 'usdt_jetton_wallet', lastPolledAt: null, updatedAt: created },
    ])
    const res = await t.app.inject({ method: 'GET', url: '/health' })
    expect(res.json<HealthResponse>().worker).toEqual({
      lastPollAt: recent.toISOString(),
      ageSec: 60,
      stale: true,
    })
  })

  it('treats a just-registered cursor that has not polled yet as healthy', async () => {
    const created = new Date(fixedNow.getTime() - 1_000)
    await t.handle.db.insert(scanCursors).values({
      account: '0:BB',
      label: 'usdt_jetton_wallet',
      lastPolledAt: null,
      updatedAt: created,
    })
    const res = await t.app.inject({ method: 'GET', url: '/health' })
    expect(res.json<HealthResponse>().worker).toEqual({ lastPollAt: null, ageSec: 1, stale: false })
  })

  it('answers 404 as a JSON error for unknown routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'GET /nope not found' } })
  })
})

describe('GET /health with an unreachable database', () => {
  it('answers 503 within 3 seconds', async () => {
    const t = buildBrokenDbApp()
    await t.app.ready()
    try {
      const started = Date.now()
      const res = await t.app.inject({ method: 'GET', url: '/health' })
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(res.statusCode).toBe(503)
      expect(res.json<HealthResponse>()).toMatchObject({ ok: false, db: 'down' })
    } finally {
      await t.close()
    }
  })
})

describe('createDb defaults', () => {
  it('routes idle client errors to the handler instead of crashing the process', async () => {
    const seen: string[] = []
    const handle = createDb({
      url: 'postgres://tma:tma@127.0.0.1:1/tma',
      onError: (error) => seen.push(error.message),
    })
    expect(handle.pool.listenerCount('error')).toBe(1)
    // Without a listener this emit would throw (uncaught 'error' event).
    expect(() => handle.pool.emit('error', new Error('connection reset'))).not.toThrow()
    expect(seen).toEqual(['connection reset'])
    await handle.close()

    const silent = createDb({ url: 'postgres://tma:tma@127.0.0.1:1/tma' })
    expect(silent.pool.listenerCount('error')).toBe(1)
    await silent.close()
  })

  it('configures connection and statement timeouts of 2 seconds', async () => {
    const handle = createDb({ url: 'postgres://tma:tma@127.0.0.1:1/tma' })
    const options = handle.pool.options as {
      connectionTimeoutMillis?: number
      statement_timeout?: number
    }
    expect(options.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS)
    expect(options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS)
    expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBe(2000)
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBe(2000)
    await handle.close()
  })
})
