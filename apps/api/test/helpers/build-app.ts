import { fileURLToPath } from 'node:url'

import { createDb, type DbHandle } from '@tma/db'
import { createTestDb } from '@tma/db/testing'
import type { FastifyInstance } from 'fastify'

import { buildApp, type AppDeps } from '../../src/app'
import { loadShopConfig, type LoadedShopConfig } from '../../src/config/shop'
import { parseEnv, type Env } from '../../src/env'

export const configDir = fileURLToPath(new URL('../../../../config/', import.meta.url))

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_VERSION: 'test',
  DATABASE_URL: 'postgres://unused',
  TELEGRAM_BOT_TOKEN: '123456:TEST',
  TELEGRAM_ADMIN_IDS: '',
  TON_NETWORK: 'testnet',
  MERCHANT_WALLET: 'kQD0GKBM8ZbryVk2aESmzfU6b9b_8era_IkvBSELujFZPsyy',
  USDT_JETTON_MASTER: 'kQD0GKBM8ZbryVk2aESmzfU6b9b_8era_IkvBSELujFZPsyy',
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({ ...TEST_ENV, ...overrides })
}

let cachedShop: LoadedShopConfig | undefined
export function testShop(): LoadedShopConfig {
  cachedShop ??= loadShopConfig(configDir)
  return cachedShop
}

export interface TestApp {
  app: FastifyInstance
  handle: DbHandle
  close: () => Promise<void>
}

/** App wired to the test database; call `close()` in afterAll. */
export function buildTestApp(
  overrides: Partial<AppDeps> & { env?: Env } = {},
  handle: DbHandle = createTestDb(),
): TestApp {
  const app = buildApp(
    {
      env: overrides.env ?? testEnv(),
      db: overrides.db ?? handle.db,
      shop: overrides.shop ?? testShop(),
      now: overrides.now,
    },
    { logger: false },
  )
  return {
    app,
    handle,
    close: async () => {
      await app.close()
      await handle.close()
    },
  }
}

/** App whose database points at a closed port, for failure-path tests. */
export function buildBrokenDbApp(): TestApp {
  const handle = createDb({ url: 'postgres://tma:tma@127.0.0.1:1/tma', max: 1 })
  return buildTestApp({}, handle)
}
