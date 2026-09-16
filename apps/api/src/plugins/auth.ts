import fp from 'fastify-plugin'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { isAdminId } from '../auth/admin-ids'
import { InitDataError, verifyInitData, type VerifiedInitData } from '../auth/init-data'
import { ApiError } from '../errors'

/**
 * Every request carries the raw init data in `Authorization: tma <raw>`; the signature is
 * checked on each call (HMAC costs microseconds, and there is no session store to keep in
 * sync). Admin rights are decided here and nowhere else: the browser only gets a hint.
 */

declare module 'fastify' {
  interface FastifyRequest {
    initData: VerifiedInitData | null
  }
  interface FastifyInstance {
    requireTma: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export function initDataOf(request: FastifyRequest): VerifiedInitData {
  if (!request.initData) {
    // A route registered without requireTma: fail closed instead of serving an anonymous user.
    throw new ApiError(401, 'initdata_missing', 'authentication required')
  }
  return request.initData
}

export const authPlugin = fp(
  (app, _options, done) => {
    app.decorateRequest('initData', null)

    app.decorate('requireTma', async (request: FastifyRequest) => {
      const header = request.headers.authorization
      if (!header) {
        throw new ApiError(401, 'initdata_missing', 'Authorization header is missing')
      }
      const separator = header.indexOf(' ')
      const scheme = separator === -1 ? header : header.slice(0, separator)
      // Raw init data is URL-encoded and never contains a space, so one split is safe.
      const raw = separator === -1 ? '' : header.slice(separator + 1)
      if (scheme.toLowerCase() !== 'tma') {
        throw new ApiError(401, 'initdata_missing', 'expected an "tma <init data>" authorization')
      }
      try {
        request.initData = verifyInitData(raw, app.deps.env.TELEGRAM_BOT_TOKEN, {
          nowSec: Math.floor(app.deps.now().getTime() / 1000),
          maxAgeSec: app.deps.env.TELEGRAM_INITDATA_TTL_SEC,
        })
      } catch (error) {
        if (error instanceof InitDataError) {
          throw new ApiError(401, error.code, error.message)
        }
        throw error
      }
    })

    app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.initData) await app.requireTma(request, reply)
      const user = initDataOf(request).user
      if (!isAdminId(app.deps.env.adminIds, user.id)) {
        throw new ApiError(403, 'forbidden', 'this Telegram account is not an administrator')
      }
    })

    done()
  },
  { name: 'auth' },
)
