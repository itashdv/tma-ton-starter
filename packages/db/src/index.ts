import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from './schema'

export * from './schema'
export { schema }

export interface CreateDbOptions {
  url: string
  /** Pool size. */
  max?: number
  /** How long to wait for a free connection / TCP connect before failing. */
  connectionTimeoutMillis?: number
  /** Server-side statement_timeout applied to every connection. */
  statementTimeoutMs?: number
  /** Optional application_name for pg_stat_activity. */
  applicationName?: string
  /**
   * Receives errors of idle pooled connections (server restart, network drop). The pool emits
   * them as `error` events, and without a listener Node treats one as an uncaught exception
   * and kills the process. Default: stderr.
   */
  onError?: (error: Error) => void
}

export const DEFAULT_CONNECTION_TIMEOUT_MS = 2000
export const DEFAULT_STATEMENT_TIMEOUT_MS = 2000

export function createDb(options: CreateDbOptions) {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    application_name: options.applicationName ?? 'tma',
  })
  const onError =
    options.onError ??
    ((error: Error) => {
      console.error(`[db] idle client error: ${error.message}`)
    })
  // The pool drops the broken client itself; the next query gets a fresh connection.
  pool.on('error', onError)
  const db = drizzle({ client: pool, schema })
  return {
    db,
    pool,
    close: () => pool.end(),
  }
}

export type DbHandle = ReturnType<typeof createDb>
export type Db = DbHandle['db']

/** Extracts the SQLSTATE code from a pg error, including errors wrapped by drizzle. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const direct = (error as { code?: unknown }).code
  if (typeof direct === 'string') return direct
  const cause = (error as { cause?: unknown }).cause
  return pgErrorCode(cause)
}

export const PG_UNIQUE_VIOLATION = '23505'
export const PG_CHECK_VIOLATION = '23514'
export const PG_INVALID_TEXT_REPRESENTATION = '22P02'
