import { createDb } from '@tma/db'
import pino from 'pino'

import { loadRuntime } from './runtime'
import { createBotApi } from './telegram/bot-api'
import { createToncenterClient } from './ton/toncenter'
import { expireOnce } from './worker/expirer'
import { acquireWorkerLock } from './worker/lock'
import { abortableSleep, runLoop } from './worker/main'
import { notifyOnce } from './worker/notifier'
import { rescanRecentOnce, scanAccountOnce, type ScannerDeps } from './worker/scanner'
import { StartupError, prepareWorker } from './worker/startup'

/**
 * Payment worker entrypoint: one process per database that scans the merchant accounts,
 * settles orders, expires stale ones and delivers the notification outbox.
 *
 * Exit codes (systemd restarts on any non-zero code; the number tells the operator why):
 *   0  clean stop after SIGTERM/SIGINT
 *   1  fatal error (invalid environment, toncenter unreachable at startup, unexpected crash)
 *   2  startup precondition failed (merchant wallet not active, jetton wallet pin or decimals mismatch)
 *   3  another worker holds the advisory lock
 *   4  the lock connection was lost while running
 */
export const EXIT_CODES = { ok: 0, fatal: 1, startup: 2, lockBusy: 3, lockLost: 4 } as const

const SHUTDOWN_DEADLINE_MS = 20_000
const DB_STATEMENT_TIMEOUT_MS = 30_000

const { env, shop } = loadRuntime()
const log = pino({ level: env.LOG_LEVEL, name: 'worker' })
const now = () => new Date()

const lock = await acquireWorkerLock({
  url: env.DATABASE_URL,
  onLost: (reason) => {
    log.fatal({ reason }, 'worker lock lost, exiting for a restart')
    process.exit(EXIT_CODES.lockLost)
  },
})
if (!lock) {
  log.error('another worker instance holds the lock for this database')
  process.exit(EXIT_CODES.lockBusy)
}

const handle = createDb({
  url: env.DATABASE_URL,
  max: 4,
  statementTimeoutMs: DB_STATEMENT_TIMEOUT_MS,
  applicationName: 'tma-worker',
  onError: (error) => log.error({ err: error }, 'db: idle client error'),
})
// One stop signal for the loop, the scanner's paging and the toncenter client's retries, so a
// SIGTERM during an outage does not wait out a minute of backoff.
const controller = new AbortController()
const ton = createToncenterClient({
  baseUrl: env.toncenterUrl,
  apiKey: env.TONCENTER_API_KEY,
  policy: 'worker',
  signal: controller.signal,
})

async function closeAll(): Promise<void> {
  await lock?.release()
  await handle.close()
}

const plan = await prepareWorker({ env, shop, ton, db: handle.db, log, now }).catch(
  async (error: unknown) => {
    log.error({ err: error }, 'worker startup failed')
    await closeAll()
    process.exit(error instanceof StartupError ? error.exitCode : EXIT_CODES.fatal)
  },
)

const botApi = createBotApi({
  token: env.TELEGRAM_BOT_TOKEN,
  baseUrl: env.TELEGRAM_BOT_API_BASE,
  testDc: env.TELEGRAM_TEST_DC,
})
const scanner: ScannerDeps = {
  db: handle.db,
  ton,
  log,
  now,
  batchLimit: env.WORKER_BATCH_LIMIT,
  ctx: plan.ctx,
  signal: controller.signal,
}

let stopping = false
function stop(signal: string): void {
  if (stopping) {
    log.warn({ signal }, 'second signal received, exiting immediately')
    process.exit(130)
  }
  stopping = true
  log.info({ signal }, 'worker stopping at the next step boundary')
  controller.abort()
  setTimeout(() => {
    log.error('graceful shutdown timed out')
    process.exit(EXIT_CODES.fatal)
  }, SHUTDOWN_DEADLINE_MS).unref()
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))

log.info(
  {
    shop: shop.shop.name,
    network: env.TON_NETWORK,
    merchant: env.merchantRaw,
    jettonWallet: plan.ctx.merchantJettonWalletRaw,
    accounts: plan.accounts.length,
    pollMs: env.WORKER_POLL_MS,
  },
  'worker started',
)

await runLoop({
  steps: {
    scan: async () => {
      // One account failing to scan must not hide the other one.
      for (const account of plan.accounts) {
        try {
          await scanAccountOnce(scanner, account)
        } catch (error) {
          log.error({ err: error, account: account.account }, 'scan failed')
        }
      }
    },
    expire: async () => {
      await expireOnce({ db: handle.db, now, log })
    },
    notify: async () => {
      await notifyOnce({ db: handle.db, botApi, shop, env, now, log })
    },
    rescan: async () => {
      for (const account of plan.accounts) {
        try {
          await rescanRecentOnce(scanner, account, env.WORKER_RESCAN_WINDOW_SEC)
        } catch (error) {
          log.error({ err: error, account: account.account }, 'rescan failed')
        }
      }
    },
  },
  pollMs: env.WORKER_POLL_MS,
  rescanMinutes: env.WORKER_RESCAN_MINUTES,
  now,
  sleep: abortableSleep,
  log,
  signal: controller.signal,
})

await closeAll()
log.info('worker stopped')
process.exit(EXIT_CODES.ok)
