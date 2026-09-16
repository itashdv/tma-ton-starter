import pg from 'pg'

export const WORKER_LOCK_NAME = 'tma-worker'

export const DEFAULT_LOCK_CONNECTION_TIMEOUT_MS = 5000

export interface WorkerLock {
  /** Unlocks and closes the connection. Idempotent. */
  release: () => Promise<void>
}

export interface AcquireLockOptions {
  url: string
  /** Called once when the lock connection ends or errors after the lock was acquired: the lock is gone with it. */
  onLost: (reason: string) => void
  applicationName?: string
  connectionTimeoutMillis?: number
}

const TRY_LOCK_SQL = 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked'
const UNLOCK_SQL = 'SELECT pg_advisory_unlock(hashtext($1))'

const ignore = () => undefined

/**
 * Exactly one worker per database. The schema invariants already make double processing
 * impossible, so a second worker could not corrupt anything; it would, however, double the
 * toncenter request budget and collide with the first one on every cursor update. A
 * session-level advisory lock is the cheapest fence: it needs no table, and Postgres drops it
 * the moment the session dies, so a crashed worker never leaves a stale lock behind.
 *
 * The lock lives on a dedicated, non-pooled connection on purpose. A session lock belongs to
 * the backend session that took it: a pool could hand that session to any other query, and
 * returning the client would leave the lock on a connection nobody controls. For the same
 * reason the lock does not survive pgbouncer in transaction mode, which swaps backends between
 * transactions: the worker must talk to Postgres directly (or through a session-mode pooler).
 *
 * Resolves to null when another process holds the lock (the caller exits 3). Throws when the
 * database cannot be reached.
 */
export async function acquireWorkerLock(options: AcquireLockOptions): Promise<WorkerLock | null> {
  const client = new pg.Client({
    connectionString: options.url,
    application_name: options.applicationName ?? 'tma-worker-lock',
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_LOCK_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
  })

  let acquired = false
  let released = false
  let lostReported = false
  const reportLost = (reason: string): void => {
    // A dropped socket emits `error` twice and then `end`; a deliberate release emits `end`
    // as well. The flags reduce all of that to one call, and to none after `release()`.
    if (!acquired || released || lostReported) return
    lostReported = true
    options.onLost(reason)
  }
  // Attached before connect(): a pg.Client without an `error` listener turns a dropped
  // socket into an uncaught exception, even while the lock query is still in flight.
  client.on('error', (error) => reportLost(`connection error: ${error.message}`))
  client.on('end', () => reportLost('connection closed'))

  await client.connect()

  let locked: boolean
  try {
    const result = await client.query<{ locked: boolean }>(TRY_LOCK_SQL, [WORKER_LOCK_NAME])
    locked = result.rows[0]?.locked === true
  } catch (error) {
    await client.end().catch(ignore)
    throw error
  }
  if (!locked) {
    await client.end().catch(ignore)
    return null
  }
  acquired = true

  return {
    release: async () => {
      if (released) return
      // Set before anything else so the `end` event of our own disconnect is not a loss.
      released = true
      if (!lostReported) {
        // Ending the session would drop the lock anyway; unlocking first only makes the
        // handover faster. Errors mean the connection is already gone.
        await client.query(UNLOCK_SQL, [WORKER_LOCK_NAME]).catch(ignore)
      }
      await client.end().catch(ignore)
    },
  }
}
