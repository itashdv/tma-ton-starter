import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'
import { sql } from 'drizzle-orm'

import { createDb, type Db, type DbHandle } from '../src/index'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** TEST_DATABASE_URL from the environment or the root .env.test; refuses non-test databases. */
export function getTestDatabaseUrl(): string {
  dotenv.config({ path: path.join(repoRoot, '.env.test'), quiet: true })
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set: copy .env.test.example to .env.test')
  }
  if (!/_test(\?|$)/.test(url)) {
    throw new Error(
      `refusing to run integration tests against "${url}": database name must end with _test`,
    )
  }
  return url
}

export function createTestDb(): DbHandle {
  return createDb({
    url: getTestDatabaseUrl(),
    max: 4,
    statementTimeoutMs: 10_000,
    applicationName: 'tma-test',
  })
}

/** Empties every table between tests. Order does not matter thanks to CASCADE. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE notifications, payments, orders, products, scan_cursors, users RESTART IDENTITY CASCADE`,
  )
}
