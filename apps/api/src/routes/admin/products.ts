import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  adminProductInputSchema,
  adminProductPatchSchema,
  createAdminProduct,
  listAdminProducts,
  updateAdminProduct,
} from '../../services/admin'

const idParams = z.object({ id: z.uuid() })

/** Catalogue management. Unlike `GET /products`, inactive rows and the delivery payload are visible. */
export async function adminProductRoutes(app: FastifyInstance): Promise<void> {
  app.get('/products', async () => ({ products: await listAdminProducts(app.deps.db) }))

  app.post('/products', async (request, reply) => {
    const body = adminProductInputSchema.parse(request.body)
    const product = await createAdminProduct(app.deps.db, body, app.deps.now())
    return reply.code(201).send({ product })
  })

  app.patch('/products/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    const body = adminProductPatchSchema.parse(request.body)
    return { product: await updateAdminProduct(app.deps.db, id, body, app.deps.now()) }
  })
}
