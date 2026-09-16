import { scanCursors, type Db, type DbHandle } from '@tma/db'
import { createTestDb, truncateAll } from '@tma/db/testing'
import { Address } from '@ton/core'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { toRawAddress } from '../../src/ton/address'
import { normalizeHash } from '../../src/ton/hash'
import { accountStatesResponseSchema } from '../../src/ton/toncenter.schemas'
import { createToncenterClient, type ToncenterClient } from '../../src/ton/toncenter'
import { StartupError, prepareWorker, type StartupDeps } from '../../src/worker/startup'
import { testEnv, testShop } from '../helpers/build-app'
import {
  fakeJettonWalletFor,
  startFakeToncenter,
  type FakeToncenter,
} from '../helpers/fake-toncenter'
import { listFixtures, loadFixture } from '../helpers/fixtures'

const env = testEnv()
const MERCHANT_JETTON_WALLET = fakeJettonWalletFor(env.merchant.address)
const MERCHANT_JETTON_WALLET_RAW = toRawAddress(MERCHANT_JETTON_WALLET)
const now = new Date('2026-09-16T12:00:00Z')

const HEAD_HASH = Buffer.alloc(32, 7).toString('base64')
const JETTON_HEAD_HASH = Buffer.alloc(32, 9).toString('base64')

let handle: DbHandle
let db: Db
let fake: FakeToncenter
let ton: ToncenterClient

beforeAll(() => {
  handle = createTestDb()
  db = handle.db
})

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await truncateAll(db)
  fake = await startFakeToncenter()
  ton = createToncenterClient({ baseUrl: fake.url, policy: 'worker', sleep: async () => {} })
  fake.setAccountStateFor(env.merchantRaw, {
    address: env.merchantRaw,
    status: 'active',
    balance: '5000000000',
    last_transaction_lt: '57501899000003',
    last_transaction_hash: HEAD_HASH,
  })
  fake.setAccountStateFor(MERCHANT_JETTON_WALLET_RAW, {
    address: MERCHANT_JETTON_WALLET_RAW,
    status: 'active',
    balance: '50000000',
    last_transaction_lt: '57501899000010',
    last_transaction_hash: JETTON_HEAD_HASH,
  })
  fake.setJettonMaster({ address: env.usdtMasterRaw, jetton_content: { decimals: '6' } })
})

afterEach(async () => {
  await fake.close()
})

function deps(overrides: Partial<StartupDeps> = {}): StartupDeps {
  return {
    env,
    shop: testShop(),
    ton,
    db,
    log: pino({ level: 'silent' }),
    now: () => now,
    ...overrides,
  }
}

describe('prepareWorker', () => {
  it('resolves the jetton wallet through get_wallet_address and registers cursors at the heads', async () => {
    const plan = await prepareWorker(deps())
    expect(plan.merchantJettonWallet?.equals(MERCHANT_JETTON_WALLET)).toBe(true)
    expect(plan.accounts).toEqual([
      { account: env.merchantRaw, label: 'ton_wallet' },
      { account: MERCHANT_JETTON_WALLET_RAW, label: 'usdt_jetton_wallet' },
    ])
    expect(plan.ctx).toEqual({
      merchantRaw: env.merchantRaw,
      merchantJettonWalletRaw: MERCHANT_JETTON_WALLET_RAW,
      usdtMasterRaw: env.usdtMasterRaw,
      minRecordNano: 1_000_000n,
    })

    const runGetMethod = fake.requests.filter((r) => r.path === '/runGetMethod')
    expect(runGetMethod).toHaveLength(1)
    const body = runGetMethod[0]?.body as { address: string; method: string }
    expect(body.method).toBe('get_wallet_address')
    expect(Address.parse(body.address).equals(env.usdtMaster?.address as Address)).toBe(true)

    const cursors = await db.select().from(scanCursors)
    expect(cursors).toHaveLength(2)
    expect(cursors.find((c) => c.label === 'ton_wallet')).toMatchObject({
      account: env.merchantRaw,
      startLt: 57501899000003n,
      lastLt: 57501899000003n,
      lastHash: normalizeHash(HEAD_HASH),
      lastPolledAt: null,
      updatedAt: now,
    })
    expect(cursors.find((c) => c.label === 'usdt_jetton_wallet')).toMatchObject({
      account: MERCHANT_JETTON_WALLET_RAW,
      startLt: 57501899000010n,
      lastLt: 57501899000010n,
      lastHash: normalizeHash(JETTON_HEAD_HASH),
    })
  })

  it('refuses an active account for which the indexer reports no last transaction', async () => {
    fake.setAccountStateFor(env.merchantRaw, { address: env.merchantRaw, status: 'active' })
    const error = await prepareWorker(deps()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StartupError)
    expect((error as Error).message).toMatch(/no last transaction/)
    expect(await db.select().from(scanCursors)).toHaveLength(0)
  })

  it('keeps an existing cursor across restarts', async () => {
    await db.insert(scanCursors).values({
      account: env.merchantRaw,
      label: 'ton_wallet',
      lastLt: 42n,
      lastHash: 'a'.repeat(64),
    })
    await prepareWorker(deps())
    const cursor = (await db.select().from(scanCursors)).find((c) => c.label === 'ton_wallet')
    expect(cursor).toMatchObject({ lastLt: 42n, lastHash: 'a'.repeat(64) })
  })

  it.each(['uninit', 'nonexist', 'frozen'])(
    'refuses to start when the merchant wallet is %s',
    async (status) => {
      fake.setAccountStateFor(env.merchantRaw, { address: env.merchantRaw, status })
      const error = await prepareWorker(deps()).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(StartupError)
      expect((error as StartupError).exitCode).toBe(2)
      expect((error as Error).message).toContain(status)
      expect(await db.select().from(scanCursors)).toHaveLength(0)
    },
  )

  it('refuses to start when the indexer does not know the merchant wallet at all', async () => {
    fake.setAccountStateFor(env.merchantRaw, null)
    await expect(prepareWorker(deps())).rejects.toBeInstanceOf(StartupError)
  })

  it('starts the jetton wallet cursor at 0 when the wallet does not exist yet', async () => {
    fake.setAccountStateFor(MERCHANT_JETTON_WALLET_RAW, null)
    await prepareWorker(deps())
    const cursor = (await db.select().from(scanCursors)).find(
      (c) => c.label === 'usdt_jetton_wallet',
    )
    expect(cursor).toMatchObject({ startLt: 0n, lastLt: 0n, lastHash: null })

    await truncateAll(db)
    fake.setAccountStateFor(MERCHANT_JETTON_WALLET_RAW, {
      address: MERCHANT_JETTON_WALLET_RAW,
      status: 'nonexist',
    })
    await prepareWorker(deps())
    expect(
      (await db.select().from(scanCursors)).find((c) => c.label === 'usdt_jetton_wallet'),
    ).toMatchObject({ lastLt: 0n, lastHash: null })
  })

  it('refuses on-chain decimals that differ from the config', async () => {
    fake.setJettonMaster({ address: env.usdtMasterRaw, jetton_content: { decimals: 9 } })
    const error = await prepareWorker(deps()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StartupError)
    expect((error as Error).message).toMatch(/9 decimals/)
    expect(await db.select().from(scanCursors)).toHaveLength(0)
  })

  it('warns but starts when the metadata has no decimals or the master is unknown to the indexer', async () => {
    const warnings: string[] = []
    const log = pino({ level: 'warn' }, { write: (line: string) => void warnings.push(line) })

    fake.setJettonMaster({ address: env.usdtMasterRaw, jetton_content: {} })
    await prepareWorker(deps({ log }))
    expect(warnings.join('\n')).toMatch(/no decimals/)

    await truncateAll(db)
    fake.setJettonMaster(null)
    await prepareWorker(deps({ log }))
    expect(warnings.join('\n')).toMatch(/does not know the jetton master/)
    expect(await db.select().from(scanCursors)).toHaveLength(2)
  })

  it('accepts a matching pin and refuses a wrong one', async () => {
    const pinned = testEnv({
      MERCHANT_USDT_JETTON_WALLET: MERCHANT_JETTON_WALLET.toString({ testOnly: true }),
    })
    const plan = await prepareWorker(deps({ env: pinned }))
    expect(plan.ctx.merchantJettonWalletRaw).toBe(MERCHANT_JETTON_WALLET_RAW)

    await truncateAll(db)
    const wrong = testEnv({
      MERCHANT_USDT_JETTON_WALLET: Address.parseRaw(`0:${'ee'.repeat(32)}`).toString({
        testOnly: true,
      }),
    })
    const error = await prepareWorker(deps({ env: wrong })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StartupError)
    expect((error as Error).message).toMatch(/does not match/)
    expect(await db.select().from(scanCursors)).toHaveLength(0)
  })

  it('scans only the main wallet when USDT is not configured', async () => {
    const tonOnly = testEnv({ USDT_JETTON_MASTER: '' })
    const shop = testShop()
    const plan = await prepareWorker(
      deps({ env: tonOnly, shop: { ...shop, shop: { ...shop.shop, currencies: ['TON'] } } }),
    )
    expect(plan.accounts).toEqual([{ account: env.merchantRaw, label: 'ton_wallet' }])
    expect(plan.ctx.merchantJettonWalletRaw).toBeNull()
    expect(plan.merchantJettonWallet).toBeNull()
    expect(fake.requests.filter((r) => r.path === '/runGetMethod')).toHaveLength(0)
  })

  it('reads the live account state fixture through the same code path', async () => {
    if (!listFixtures().includes('account-state-active')) return
    const fixture = loadFixture('account-state-active')
    const parsed = accountStatesResponseSchema.parse(fixture.response)
    const live = parsed.accounts[0]
    expect(live?.status).toBe('active')
    fake.setAccountStateFor(env.merchantRaw, { ...live, address: env.merchantRaw })
    await prepareWorker(deps())
    const cursor = (await db.select().from(scanCursors)).find((c) => c.label === 'ton_wallet')
    expect(cursor?.lastLt).toBe(BigInt(live?.last_transaction_lt ?? '0'))
    expect(cursor?.lastHash).toBe(normalizeHash(live?.last_transaction_hash ?? ''))
  })
})
