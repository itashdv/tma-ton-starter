import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { initDataOf } from '../../plugins/auth'
import {
  cancelAdminOrder,
  getAdminOrder,
  listAdminOrders,
  resendAdminNotification,
} from '../../services/admin'

const listQuery = z.object({
  status: z.enum(['pending', 'paid', 'expired', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
})
const idParams = z.object({ id: z.string().min(1).max(64) })
const cancelBody = z.object({ note: z.string().max(2000).optional() }).strict()

export async function adminOrderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/orders', async (request) => {
    const query = listQuery.parse(request.query)
    return listAdminOrders(app.deps.db, query)
  })

  app.get('/orders/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    return getAdminOrder(app.deps.db, app.deps.env, id)
  })

  app.post('/orders/:id/cancel', async (request) => {
    const { id } = idParams.parse(request.params)
    const body = cancelBody.parse(request.body ?? {})
    const admin = initDataOf(request).user
    const order = await cancelAdminOrder(app.deps.db, id, {
      adminId: BigInt(admin.id),
      note: body.note,
      now: app.deps.now(),
    })
    return { order }
  })

  app.post('/orders/:id/resend-notification', async (request) => {
    const { id } = idParams.parse(request.params)
    const notification = await resendAdminNotification(app.deps.db, id, app.deps.now())
    return { notification }
  })
}
