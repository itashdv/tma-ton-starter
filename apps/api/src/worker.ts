import pino from 'pino'

import { loadRuntime } from './runtime'

/**
 * Payment worker entrypoint. Stage A ships only the process skeleton: it validates the
 * environment and config exactly like the API, then idles with a heartbeat so that
 * `pnpm dev` and the systemd unit already exercise the real startup path.
 * The scanner, settlement and notifier arrive in stage C.
 */
const { env, shop } = loadRuntime()
const log = pino({ level: env.LOG_LEVEL, name: 'worker' })

log.info(
  { shop: shop.shop.name, network: env.TON_NETWORK, merchant: env.merchantRaw },
  'worker started (stage A stub: payment listener not implemented yet)',
)

const heartbeat = setInterval(() => log.debug('worker idle'), 60_000)

function shutdown(signal: string): void {
  log.info({ signal }, 'worker stopping')
  clearInterval(heartbeat)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
