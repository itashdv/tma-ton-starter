import path from 'node:path'

import { createDb } from '../index'
import { loadProductsFromConfig, seedProducts } from '../seed'
import { loadRootEnv, repoRoot, requireEnv } from './env'

loadRootEnv()
const url = requireEnv('DATABASE_URL')
const overwrite = process.argv.includes('--overwrite')
const configDir = path.join(repoRoot, 'config')

const items = loadProductsFromConfig(configDir)
const handle = createDb({ url, max: 2, statementTimeoutMs: 10_000 })
try {
  const result = await seedProducts(handle.db, items, { overwrite })
  console.log(
    `seed ${overwrite ? '(overwrite) ' : ''}done: inserted ${result.inserted}, updated ${result.updated}, skipped ${result.skipped}`,
  )
} finally {
  await handle.close()
}
