import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

import { parseEnv, validateEnvAgainstShop, type Env } from './env'
import { loadShopConfig, type LoadedShopConfig } from './config/shop'

/**
 * Repository root, derived from this file's location. `src/` and `dist/` sit at the same
 * depth inside apps/api, so the same relative path works for `tsx src/server.ts` and
 * `node dist/server.js`.
 */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

export interface Runtime {
  env: Env
  shop: LoadedShopConfig
}

/** Loads .env (outside production), parses the environment and the config directory. */
export function loadRuntime(): Runtime {
  if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true })
  }
  const env = parseEnv(process.env)
  const shop = loadShopConfig(path.join(repoRoot, 'config'))
  validateEnvAgainstShop(env, shop.shop)
  return { env, shop }
}
