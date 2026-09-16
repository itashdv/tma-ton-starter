import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { initDataOf } from '../plugins/auth'
import { createOrder, getOrderForUser, listOrders, submitOrder } from '../services/orders'
import { upsertUser } from '../services/users'

const createOrderBody = z.object({
  productId: z.uuid(),
  currency: z.enum(['TON', 'USDT']),
  walletAddress: z.string().min(1),
})

const submittedBody = z.object({ boc: z.string().min(1) })
const orderParams = z.object({ id: z.string() })

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/orders', { preHandler: app.requireTma }, async (request, reply) => {
    const user = initDataOf(request).user
    const body = createOrderBody.parse(request.body)
    // The order references the user, so the row must exist before the insert.
    await upsertUser(app.deps.db, user, app.deps.now())
    const result = await createOrder(app.deps, {
      userId: user.id,
      productId: body.productId,
      currency: body.currency,
      walletAddress: body.walletAddress,
    })
    return reply.code(201).send(result)
  })

  app.get('/orders', { preHandler: app.requireTma }, async (request) => {
    const user = initDataOf(request).user
    return { orders: await listOrders(app.deps.db, user.id) }
  })

  app.get('/orders/:id', { preHandler: app.requireTma }, async (request) => {
    const user = initDataOf(request).user
    const { id } = orderParams.parse(request.params)
    return { order: await getOrderForUser(app.deps.db, user.id, id) }
  })

  app.post('/orders/:id/submitted', { preHandler: app.requireTma }, async (request) => {
    const user = initDataOf(request).user
    const { id } = orderParams.parse(request.params)
    const { boc } = submittedBody.parse(request.body)
    return { order: await submitOrder(app.deps, user.id, id, boc) }
  })
}
