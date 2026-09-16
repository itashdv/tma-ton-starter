import type { ProductDto } from '@tma/shared'
import type { FastifyInstance } from 'fastify'

import { listActiveProducts } from '../services/orders'

/** Public catalogue. `deliveryPayload` is never exposed here: it is the good itself. */
export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get('/products', async () => {
    const rows = await listActiveProducts(app.deps.db)
    const products: ProductDto[] = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      imageUrl: row.imageUrl,
      priceTonNano: row.priceTonNano?.toString() ?? null,
      priceUsdtUnits: row.priceUsdtUnits?.toString() ?? null,
      sortOrder: row.sortOrder,
    }))
    return { products }
  })
}
