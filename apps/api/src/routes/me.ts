import type { MeResponse } from '@tma/shared'
import type { FastifyInstance } from 'fastify'

import { isAdminId } from '../auth/admin-ids'
import { initDataOf } from '../plugins/auth'
import { upsertUser } from '../services/users'

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { preHandler: app.requireTma }, async (request): Promise<MeResponse> => {
    const { env, shop, db, now } = app.deps
    const user = initDataOf(request).user
    await upsertUser(db, user, now())
    return {
      user: {
        id: String(user.id),
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        languageCode: user.languageCode,
        photoUrl: user.photoUrl,
        isPremium: user.isPremium,
        allowsWriteToPm: user.allowsWriteToPm,
      },
      isAdmin: isAdminId(env.adminIds, user.id),
      network: env.TON_NETWORK,
      tonNetworkId: env.tonNetworkId,
      botUsername: env.TELEGRAM_BOT_USERNAME ?? null,
      miniAppShortName: env.TELEGRAM_MINIAPP_SHORT_NAME ?? null,
      currencies: shop.shop.currencies,
    }
  })
}
