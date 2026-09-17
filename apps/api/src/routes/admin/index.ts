import type { FastifyInstance } from 'fastify'

import { adminHealthRoutes } from './health'
import { adminOrderRoutes } from './orders'
import { adminPaymentRoutes } from './payments'
import { adminProductRoutes } from './products'

/**
 * Everything under `/admin` is for TELEGRAM_ADMIN_IDS only, and that is enforced here, once,
 * for the whole subtree: hooks added inside a plugin apply to every route registered in that
 * context and its children, so a route added later is protected by construction rather than by
 * remembering a `preHandler`. The checks run at `onRequest`, before the body is even parsed, in
 * a fixed order: a valid Telegram signature first (401), then membership in the admin list
 * (403). Unknown paths under the prefix go through the same gate, so an anonymous caller cannot
 * map the protected surface by probing for 404s.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireTma)
  app.addHook('onRequest', app.requireAdmin)
  app.setNotFoundHandler({ preHandler: [app.requireTma, app.requireAdmin] }, (request, reply) => {
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: `${request.method} ${request.url} not found` } })
  })

  await app.register(adminProductRoutes)
  await app.register(adminOrderRoutes)
  await app.register(adminPaymentRoutes)
  await app.register(adminHealthRoutes)
}
