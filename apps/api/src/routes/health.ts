import { DEFAULT_CONNECTION_TIMEOUT_MS, scanCursors } from '@tma/db'
import type { HealthResponse } from '@tma/shared'
import type { FastifyInstance } from 'fastify'

const DB_CHECK_TIMEOUT_MS = DEFAULT_CONNECTION_TIMEOUT_MS

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

interface CursorHeartbeat {
  lastPolledAt: Date | null
  updatedAt: Date
}

/**
 * Worker heartbeat from scan cursors. The most lagging account decides: a cursor that has never
 * polled counts from its creation (`updated_at`), so a scanner that registered an account but
 * never completed a poll turns stale instead of being hidden. With no cursors at all the worker
 * has never run and a fresh deployment reports a null, non-stale heartbeat.
 */
export function workerHeartbeat(
  cursors: CursorHeartbeat[],
  now: Date,
  pollMs: number,
): HealthResponse['worker'] {
  if (cursors.length === 0) return { lastPollAt: null, ageSec: null, stale: false }
  const effective = cursors.map((c) => (c.lastPolledAt ?? c.updatedAt).getTime())
  const oldestEffective = Math.min(...effective)
  const polled = cursors.flatMap((c) => (c.lastPolledAt ? [c.lastPolledAt.getTime()] : []))
  const ageSec = Math.max(0, Math.floor((now.getTime() - oldestEffective) / 1000))
  return {
    lastPollAt: polled.length > 0 ? new Date(Math.min(...polled)).toISOString() : null,
    ageSec,
    stale: ageSec > (3 * pollMs) / 1000,
  }
}

/** `GET /health`: 200 when the database answers within 2 s (503 otherwise) plus the heartbeat. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const { db, env, now } = app.deps
    const version = env.APP_VERSION

    let cursors: CursorHeartbeat[]
    try {
      cursors = await withTimeout(
        db
          .select({ lastPolledAt: scanCursors.lastPolledAt, updatedAt: scanCursors.updatedAt })
          .from(scanCursors),
        DB_CHECK_TIMEOUT_MS,
      )
    } catch (error) {
      app.log.warn({ err: error }, 'health: database check failed')
      const body: HealthResponse = {
        ok: false,
        db: 'down',
        version,
        worker: { lastPollAt: null, ageSec: null, stale: false },
      }
      return reply.code(503).send(body)
    }

    const body: HealthResponse = {
      ok: true,
      db: 'up',
      version,
      worker: workerHeartbeat(cursors, now(), env.WORKER_POLL_MS),
    }
    return body
  })
}
