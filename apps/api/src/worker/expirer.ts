import type { Db } from '@tma/db'
import type pino from 'pino'

import { expireOrdersOnce } from '../services/orders'

/**
 * Moves pending orders past their deadline to `expired`. The state is advisory: a payment that
 * lands afterwards still pays the order (flagged `paid_late`), and the settlement checks
 * `expires_at` itself, so a slow expirer cannot let a late payment through unflagged.
 */
export interface ExpirerDeps {
  db: Db
  now: () => Date
  log: pino.Logger
}

export async function expireOnce(deps: ExpirerDeps): Promise<number> {
  const expired = await expireOrdersOnce(deps.db, deps.now())
  if (expired > 0) deps.log.info({ expired }, 'expirer: orders expired')
  return expired
}
