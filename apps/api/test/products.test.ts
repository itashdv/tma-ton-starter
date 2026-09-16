import { truncateAll } from '@tma/db/testing'
import type { ProductDto } from '@tma/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildTestApp, type TestApp } from './helpers/build-app'
import { seedProduct } from './helpers/auth'

let t: TestApp

beforeAll(async () => {
  t = buildTestApp()
  await t.app.ready()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await truncateAll(t.handle.db)
})

describe('GET /products', () => {
  it('returns active products sorted by sort order, with amounts as digit strings', async () => {
    await seedProduct(t.handle.db, { slug: 'b', title: 'Second', sortOrder: 20 })
    await seedProduct(t.handle.db, {
      slug: 'a',
      title: 'First',
      sortOrder: 10,
      priceUsdtUnits: null,
    })
    await seedProduct(t.handle.db, { slug: 'hidden', title: 'Hidden', isActive: false })

    const response = await t.app.inject({ method: 'GET', url: '/products' })
    expect(response.statusCode).toBe(200)
    const { products } = response.json<{ products: ProductDto[] }>()
    expect(products.map((p) => p.slug)).toEqual(['a', 'b'])
    expect(products[0]).toMatchObject({
      title: 'First',
      priceTonNano: '1500000000',
      priceUsdtUnits: null,
    })
    expect(products[1]?.priceUsdtUnits).toBe('5000000')
  })

  it('never exposes the delivery payload', async () => {
    await seedProduct(t.handle.db, { deliveryPayload: 'SECRET-CODE' })
    const response = await t.app.inject({ method: 'GET', url: '/products' })
    expect(response.body).not.toContain('SECRET-CODE')
    expect(Object.keys(response.json<{ products: ProductDto[] }>().products[0] ?? {})).toEqual([
      'id',
      'slug',
      'title',
      'description',
      'imageUrl',
      'priceTonNano',
      'priceUsdtUnits',
      'sortOrder',
    ])
  })

  it('is public: no authorization needed', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/products' })
    expect(response.statusCode).toBe(200)
  })
})
