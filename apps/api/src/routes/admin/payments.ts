import { ORDER_ID_RE, normalizeComment } from '@tma/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { initDataOf } from '../../plugins/auth'
import { attachAdminPayment, listAdminPayments } from '../../services/admin'

const listQuery = z.object({
  status: z.enum(['matched', 'underpaid', 'unmatched', 'ignored']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
})
const idParams = z.object({ id: z.uuid() })
const attachBody = z
  .object({
    // Pasted ids come with whitespace and capitals; the on-chain comment gets the same treatment.
    orderId: z
      .string()
      .transform(normalizeComment)
      .pipe(z.string().regex(ORDER_ID_RE, 'orderId must be a 16-character order id')),
    force: z.boolean().optional(),
  })
  .strict()

export async function adminPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/payments', async (request) => {
    const query = listQuery.parse(request.query)
    return listAdminPayments(app.deps.db, app.deps.env, query)
  })

  app.post('/payments/:id/attach', async (request) => {
    const { id } = idParams.parse(request.params)
    const body = attachBody.parse(request.body)
    const admin = initDataOf(request).user
    return attachAdminPayment(app.deps.db, app.deps.env, {
      paymentId: id,
      orderId: body.orderId,
      force: body.force ?? false,
      adminId: BigInt(admin.id),
      now: app.deps.now(),
    })
  })
}
