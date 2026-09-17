import { fileURLToPath } from 'node:url'

import { products } from '@tma/db'
import { loadProductsFromConfig, seedProducts } from '@tma/db/seed'
import { truncateAll } from '@tma/db/testing'
import type { AdminProductDto, OrderDto, ProductDto } from '@tma/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { TestApp } from '../helpers/build-app'
import { adminApp, asAdmin, asUser, seedOrder, seedProduct, seedUser } from './helpers'

const configDir = fileURLToPath(new URL('../../../../config/', import.meta.url))

let t: TestApp

beforeAll(async () => {
  t = adminApp()
  await t.app.ready()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await truncateAll(t.handle.db)
})

const VALID = {
  slug: 'course',
  title: 'Course',
  description: 'A course',
  priceTonNano: '2500000000',
  priceUsdtUnits: '12340000',
  deliveryPayload: 'https://example.com/course',
  deliverInChat: true,
  sortOrder: 5,
}

function post(body: Record<string, unknown>) {
  return t.app.inject({ method: 'POST', url: '/admin/products', headers: asAdmin(), payload: body })
}

function patch(id: string, body: Record<string, unknown>) {
  return t.app.inject({
    method: 'PATCH',
    url: `/admin/products/${id}`,
    headers: asAdmin(),
    payload: body,
  })
}

async function publicCatalogue(): Promise<ProductDto[]> {
  const response = await t.app.inject({ method: 'GET', url: '/products' })
  return response.json<{ products: ProductDto[] }>().products
}

describe('GET /admin/products', () => {
  it('lists inactive products and the delivery payload, sorted like the catalogue', async () => {
    await seedProduct(t.handle.db, {
      slug: 'b',
      title: 'B',
      sortOrder: 2,
      deliveryPayload: 'CODE-B',
    })
    await seedProduct(t.handle.db, {
      slug: 'hidden',
      title: 'Hidden',
      sortOrder: 1,
      isActive: false,
    })
    const response = await t.app.inject({
      method: 'GET',
      url: '/admin/products',
      headers: asAdmin(),
    })
    expect(response.statusCode).toBe(200)
    const { products: list } = response.json<{ products: AdminProductDto[] }>()
    expect(list.map((p) => p.slug)).toEqual(['hidden', 'b'])
    expect(list[0]).toMatchObject({
      isActive: false,
      deliveryPayload: 'https://example.com/download',
    })
    expect(list[1]).toMatchObject({
      isActive: true,
      deliveryPayload: 'CODE-B',
      deliverInChat: false,
      priceTonNano: '1500000000',
      priceUsdtUnits: '5000000',
    })
    expect(typeof list[0]?.createdAt).toBe('string')
  })
})

describe('POST /admin/products', () => {
  it('creates a product from smallest-unit digit strings and keeps the delivery fields', async () => {
    const response = await post({ ...VALID, priceTonNano: '1000000000000000000' })
    expect(response.statusCode).toBe(201)
    const { product } = response.json<{ product: AdminProductDto }>()
    expect(product).toMatchObject({
      slug: 'course',
      priceTonNano: '1000000000000000000',
      priceUsdtUnits: '12340000',
      deliveryPayload: 'https://example.com/course',
      deliverInChat: true,
      isActive: true,
      sortOrder: 5,
    })
    const [row] = await t.handle.db.select().from(products).where(eq(products.id, product.id))
    expect(row?.priceTonNano).toBe(10n ** 18n)
    expect(row?.priceUsdtUnits).toBe(12_340_000n)
    expect(row?.deliverInChat).toBe(true)
    expect((await publicCatalogue()).map((p) => p.slug)).toEqual(['course'])
  })

  it('applies defaults for optional fields', async () => {
    const response = await post({ slug: 'min', title: 'Min', priceTonNano: '1' })
    expect(response.statusCode).toBe(201)
    expect(response.json<{ product: AdminProductDto }>().product).toMatchObject({
      description: '',
      imageUrl: null,
      priceUsdtUnits: null,
      deliveryPayload: null,
      deliverInChat: false,
      isActive: true,
      sortOrder: 0,
    })
  })

  it('requires at least one price', async () => {
    for (const body of [
      { slug: 'x', title: 'X' },
      { slug: 'x', title: 'X', priceTonNano: null, priceUsdtUnits: null },
    ]) {
      const response = await post(body)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'price_required' } })
    }
    expect(await t.handle.db.select().from(products)).toHaveLength(0)
  })

  it('rejects prices that are not positive integers in the smallest units', async () => {
    for (const price of ['1.5', '0', '-1', '', ' 1', '1e9', '99999999999999999999']) {
      const response = await post({ slug: 'x', title: 'X', priceTonNano: price })
      expect(response.statusCode, `price ${JSON.stringify(price)}`).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'validation_error' } })
    }
    const numeric = await post({ slug: 'x', title: 'X', priceTonNano: 1500000000 })
    expect(numeric.statusCode).toBe(400)
  })

  it('rejects a taken slug, a malformed slug and unknown fields', async () => {
    await seedProduct(t.handle.db, { slug: 'course' })
    const dup = await post(VALID)
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ error: { code: 'slug_taken' } })

    const badSlug = await post({ ...VALID, slug: 'Bad Slug' })
    expect(badSlug.statusCode).toBe(400)
    const unknown = await post({ ...VALID, slug: 'other', priceTon: '1.5' })
    expect(unknown.statusCode).toBe(400)
  })
})

describe('PATCH /admin/products/:id', () => {
  it('changes only the given fields and a paid order reveals the new payload', async () => {
    const product = await seedProduct(t.handle.db, { deliveryPayload: 'OLD-CODE' })
    await seedUser(t.handle.db)
    const order = await seedOrder(t.handle.db, {
      id: 'abcd000000000000',
      productId: product.id,
      status: 'paid',
      paidAt: new Date(),
    })

    const response = await patch(product.id, { deliveryPayload: 'NEW-CODE' })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ product: AdminProductDto }>().product).toMatchObject({
      deliveryPayload: 'NEW-CODE',
      title: product.title,
      priceTonNano: '1500000000',
    })

    const seen = await t.app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: asUser(),
    })
    expect(seen.json<{ order: OrderDto }>().order.delivery).toEqual({
      payload: 'NEW-CODE',
      deliverInChat: false,
    })
  })

  it('hides a deactivated product from the public catalogue and shows it again', async () => {
    const product = await seedProduct(t.handle.db)
    expect(await publicCatalogue()).toHaveLength(1)
    expect((await patch(product.id, { isActive: false })).statusCode).toBe(200)
    expect(await publicCatalogue()).toHaveLength(0)
    expect((await patch(product.id, { isActive: true })).statusCode).toBe(200)
    expect(await publicCatalogue()).toHaveLength(1)
  })

  it('refuses to clear the last price and leaves the row untouched', async () => {
    const product = await seedProduct(t.handle.db, { priceUsdtUnits: null })
    const response = await patch(product.id, { priceTonNano: null })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'price_required' } })
    const [row] = await t.handle.db.select().from(products).where(eq(products.id, product.id))
    expect(row?.priceTonNano).toBe(1_500_000_000n)

    // Clearing one price while the other stays is fine.
    const both = await seedProduct(t.handle.db, { slug: 'both' })
    expect((await patch(both.id, { priceTonNano: null })).statusCode).toBe(200)
  })

  it('validates prices, slugs and ids like the create route', async () => {
    const product = await seedProduct(t.handle.db)
    await seedProduct(t.handle.db, { slug: 'taken' })
    expect((await patch(product.id, { priceTonNano: '1.5' })).statusCode).toBe(400)
    const dup = await patch(product.id, { slug: 'taken' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ error: { code: 'slug_taken' } })
    expect((await patch('not-a-uuid', { title: 'x' })).statusCode).toBe(400)
    const missing = await patch('00000000-0000-4000-8000-000000000000', { title: 'x' })
    expect(missing.statusCode).toBe(404)
  })

  it('survives a repeated seed: config never overwrites an admin edit', async () => {
    const items = loadProductsFromConfig(configDir)
    await seedProducts(t.handle.db, items)
    const first = items[0]
    if (!first) throw new Error('config has no products')
    const [row] = await t.handle.db.select().from(products).where(eq(products.slug, first.slug))
    if (!row) throw new Error('seeded product missing')

    expect((await patch(row.id, { priceTonNano: '777000000000' })).statusCode).toBe(200)
    const again = await seedProducts(t.handle.db, items)
    expect(again.inserted).toBe(0)
    const [after] = await t.handle.db.select().from(products).where(eq(products.id, row.id))
    expect(after?.priceTonNano).toBe(777_000_000_000n)

    // Only an explicit overwrite re-syncs config-owned fields.
    await seedProducts(t.handle.db, items, { overwrite: true })
    const [resynced] = await t.handle.db.select().from(products).where(eq(products.id, row.id))
    expect(resynced?.priceTonNano).toBe(first.priceTonNano)
  })
})

describe('review follow-ups: products', () => {
  it('clears nullable fields with null and keeps them when absent', async () => {
    const product = await seedProduct(t.handle.db, { deliveryPayload: 'CODE' })
    await patch(product.id, { imageUrl: 'https://example.com/a.png' })
    const cleared = await patch(product.id, { imageUrl: null, deliveryPayload: null })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json<{ product: AdminProductDto }>().product).toMatchObject({
      imageUrl: null,
      deliveryPayload: null,
    })
    const kept = await patch(product.id, { title: 'Renamed' })
    expect(kept.json<{ product: AdminProductDto }>().product).toMatchObject({
      title: 'Renamed',
      deliveryPayload: null,
    })
  })

  it('accepts only web image URLs', async () => {
    for (const imageUrl of [
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'file:///etc/passwd',
    ]) {
      const response = await post({ slug: 'img', title: 'Img', priceTonNano: '1', imageUrl })
      expect(response.statusCode, imageUrl).toBe(400)
    }
    const ok = await post({
      slug: 'img',
      title: 'Img',
      priceTonNano: '1',
      imageUrl: 'https://cdn.example.com/x.png',
    })
    expect(ok.statusCode).toBe(201)
  })
})
