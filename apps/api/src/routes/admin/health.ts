import type { FastifyInstance } from 'fastify'

import { adminHealth } from '../../services/admin'

/** Operator view: per-account cursors with lag and last error, ledger and outbox counters. */
export async function adminHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => adminHealth(app.deps.db, app.deps.env, app.deps.now()))
}
