import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

/**
 * Committed drizzle-kit output; migrations are additive and never deleted. Resolved from this
 * file, so this module must not be bundled into another package's dist.
 */
export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT'])

/**
 * True for "nothing is listening / host unknown" errors. Walks `cause` (drizzle wraps driver
 * errors in DrizzleQueryError) and AggregateError members (pg tries IPv4 and IPv6).
 */
export function isConnectionError(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 5) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true
  if (
    error instanceof AggregateError &&
    error.errors.some((e) => isConnectionError(e, depth + 1))
  ) {
    return true
  }
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string' && /connection timeout|timeout expired/i.test(message))
    return true
  return isConnectionError((error as { cause?: unknown }).cause, depth + 1)
}

/** `host:port/db` of a connection string, never the credentials. */
export function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

/** Applies all pending migrations. Idempotent: re-running with nothing pending is a no-op. */
export async function runMigrations(url: string): Promise<void> {
  if (!existsSync(migrationsFolder)) {
    throw new Error(`migrations folder not found: ${migrationsFolder}`)
  }
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 })
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder })
  } catch (error) {
    if (isConnectionError(error)) {
      throw new Error(
        `Postgres is not reachable at ${describeDatabaseUrl(url)}. ` +
          'Start it with: docker compose -f infra/docker-compose.yml up -d --wait',
        { cause: error },
      )
    }
    throw error
  } finally {
    await pool.end()
  }
}
