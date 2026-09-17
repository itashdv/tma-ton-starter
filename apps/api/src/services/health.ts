import type { HealthResponse } from '@tma/shared'

export interface CursorHeartbeat {
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
