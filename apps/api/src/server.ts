import { createDb } from '@tma/db'

import { buildApp } from './app'
import { loadRuntime } from './runtime'

const { env, shop } = loadRuntime()
const handle = createDb({ url: env.DATABASE_URL, applicationName: 'tma-api' })
const app = buildApp({ env, db: handle.db, shop })

const SHUTDOWN_DEADLINE_MS = 10_000

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    app.log.warn({ signal }, 'second signal received, exiting immediately')
    process.exit(130)
  }
  shuttingDown = true
  app.log.info({ signal }, 'shutting down')
  setTimeout(() => {
    app.log.error('graceful shutdown timed out')
    process.exit(1)
  }, SHUTDOWN_DEADLINE_MS).unref()
  try {
    await app.close()
    await handle.close()
    process.exit(0)
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed')
    process.exit(1)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT })
  app.log.info(
    { shop: shop.shop.name, network: env.TON_NETWORK, merchant: env.merchantRaw },
    'api started',
  )
} catch (error) {
  app.log.error({ err: error }, 'api failed to start')
  process.exit(1)
}
