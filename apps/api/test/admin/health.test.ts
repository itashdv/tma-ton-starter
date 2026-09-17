import { scanCursors } from '@tma/db'
import { truncateAll } from '@tma/db/testing'
import type { AdminHealthDto } from '@tma/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { testEnv, type TestApp } from '../helpers/build-app'
import {
  JETTON_WALLET,
  MERCHANT,
  NOW,
  adminApp,
  asAdmin,
  seedNotification,
  seedOrder,
  seedPayment,
  seedProduct,
  seedUser,
} from './helpers'

let t: TestApp

beforeAll(async () => {
  t = adminApp()
  await t.app.ready()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await truncateAll(t.handle.db)
})

describe('GET /admin/health', () => {
  it('reports cursors with lag, staleness and errors, counters and friendly merchant addresses', async () => {
    await t.handle.db.insert(scanCursors).values([
      {
        account: MERCHANT,
        label: 'ton_wallet',
        startLt: 100n,
        lastLt: 150n,
        lastHash: 'a'.repeat(64),
        lastPolledAt: new Date(NOW.getTime() - 2000),
        updatedAt: new Date(NOW.getTime() - 2000),
      },
      {
        account: JETTON_WALLET,
        label: 'usdt_jetton_wallet',
        startLt: 0n,
        lastLt: 0n,
        lastHash: null,
        lastPolledAt: new Date(NOW.getTime() - 60_000),
        lastError: 'ToncenterError: toncenter /transactions answered 429',
        updatedAt: new Date(NOW.getTime() - 60_000),
      },
    ])
    await seedUser(t.handle.db)
    const productId = (await seedProduct(t.handle.db)).id
    await seedOrder(t.handle.db, { id: 'aaaaaaaaaaaaaaaa', productId, status: 'pending' })
    await seedOrder(t.handle.db, { id: 'bbbbbbbbbbbbbbbb', productId, status: 'pending' })
    await seedOrder(t.handle.db, { id: 'cccccccccccccccc', productId, status: 'paid', paidAt: NOW })
    await seedPayment(t.handle.db, { status: 'unmatched' })
    await seedPayment(t.handle.db, { status: 'unmatched' })
    await seedPayment(t.handle.db, { status: 'underpaid', orderId: 'aaaaaaaaaaaaaaaa' })
    await seedPayment(t.handle.db, { status: 'ignored', currency: null, reason: 'unknown_layout' })
    await seedPayment(t.handle.db, { status: 'matched', orderId: 'cccccccccccccccc' })
    await seedNotification(t.handle.db, 'cccccccccccccccc', { status: 'failed', attempts: 8 })
    await seedNotification(t.handle.db, 'aaaaaaaaaaaaaaaa', { status: 'pending' })

    const response = await t.app.inject({ method: 'GET', url: '/admin/health', headers: asAdmin() })
    expect(response.statusCode).toBe(200)
    const health = response.json<AdminHealthDto>()
    const env = testEnv()

    expect(health.now).toBe(NOW.toISOString())
    expect(health.network).toBe('testnet')
    expect(health.pollMs).toBe(5000)
    expect(health.merchant).toEqual({
      raw: env.merchantRaw,
      address: env.merchant.address.toString({ bounceable: false, testOnly: true }),
      url: `https://testnet.tonviewer.com/${env.merchant.address.toString({ bounceable: false, testOnly: true })}`,
    })
    expect(health.merchant.address.startsWith('0Q')).toBe(true)
    expect(health.usdtMaster?.address.startsWith('kQ')).toBe(true)
    expect(health.usdtMaster?.raw).toBe(env.usdtMasterRaw)

    expect(health.cursors.map((c) => c.label)).toEqual(['ton_wallet', 'usdt_jetton_wallet'])
    expect(health.cursors[0]).toMatchObject({
      account: MERCHANT,
      startLt: '100',
      lastLt: '150',
      lastHash: 'a'.repeat(64),
      lagSeconds: 2,
      stale: false,
      lastError: null,
    })
    expect(health.cursors[0]?.address.startsWith('0Q')).toBe(true)
    expect(health.cursors[0]?.url).toContain('testnet.tonviewer.com/')
    expect(health.cursors[1]).toMatchObject({
      lagSeconds: 60,
      stale: true,
      lastError: expect.stringContaining('429'),
      lastLt: '0',
    })
    expect(health.cursors[1]?.address.startsWith('kQ')).toBe(true)
    // The heartbeat follows the most lagging account, exactly like the public /health.
    expect(health.worker).toEqual({
      lastPollAt: new Date(NOW.getTime() - 60_000).toISOString(),
      ageSec: 60,
      stale: true,
    })
    expect(health.counts).toEqual({
      unmatchedPayments: 2,
      underpaidPayments: 1,
      ignoredPayments: 1,
      failedNotifications: 1,
      pendingNotifications: 1,
      pendingOrders: 2,
      paidOrders: 1,
    })
  })

  it('handles a fresh database without cursors', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/admin/health', headers: asAdmin() })
    expect(response.statusCode).toBe(200)
    const health = response.json<AdminHealthDto>()
    expect(health.cursors).toEqual([])
    expect(health.worker).toEqual({ lastPollAt: null, ageSec: null, stale: false })
    expect(Object.values(health.counts).every((n) => n === 0)).toBe(true)
  })
})

describe('review follow-ups: health', () => {
  it('reports a never-polled cursor with a null lag and staleness from its registration time', async () => {
    await t.handle.db.insert(scanCursors).values([
      {
        account: MERCHANT,
        label: 'ton_wallet',
        lastPolledAt: null,
        updatedAt: new Date(NOW.getTime() - 1000),
      },
      {
        account: JETTON_WALLET,
        label: 'usdt_jetton_wallet',
        lastPolledAt: null,
        updatedAt: new Date(NOW.getTime() - 60_000),
      },
    ])
    const health = (
      await t.app.inject({ method: 'GET', url: '/admin/health', headers: asAdmin() })
    ).json<AdminHealthDto>()
    expect(health.cursors[0]).toMatchObject({ lagSeconds: null, lastPolledAt: null, stale: false })
    expect(health.cursors[1]).toMatchObject({ lagSeconds: null, lastPolledAt: null, stale: true })
    expect(health.worker).toEqual({ lastPollAt: null, ageSec: 60, stale: true })
  })
})
