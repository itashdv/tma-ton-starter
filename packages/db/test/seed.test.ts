import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { products, type Db, type DbHandle } from '../src/index'
import { loadProductsFromConfig, seedProducts } from '../src/seed'
import { createTestDb, truncateAll } from './helpers'

const configDir = fileURLToPath(new URL('../../../config/', import.meta.url))

let handle: DbHandle
let db: Db

beforeAll(() => {
  handle = createTestDb()
  db = handle.db
})

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await truncateAll(db)
})

async function countProducts(): Promise<number> {
  return (await db.select({ id: products.id }).from(products)).length
}

describe('seedProducts', () => {
  it('inserts every product from config/products.json with delivery fields', async () => {
    const items = loadProductsFromConfig(configDir)
    const result = await seedProducts(db, items)
    expect(result).toEqual({ inserted: items.length, updated: 0, skipped: 0 })
    expect(await countProducts()).toBe(items.length)

    const rows = await db.select().from(products)
    for (const item of items) {
      const row = rows.find((r) => r.slug === item.slug)
      expect(row, item.slug).toBeDefined()
      expect(row?.priceTonNano).toBe(item.priceTonNano)
      expect(row?.priceUsdtUnits).toBe(item.priceUsdtUnits)
      expect(row?.deliveryPayload).toBe(item.deliveryPayload)
      expect(row?.deliverInChat).toBe(item.deliverInChat)
    }
  })

  it('is insert-only by default: a second run changes nothing', async () => {
    const items = loadProductsFromConfig(configDir)
    await seedProducts(db, items)
    const second = await seedProducts(db, items)
    expect(second).toEqual({ inserted: 0, updated: 0, skipped: items.length })
    expect(await countProducts()).toBe(items.length)
  })

  it('does not overwrite admin edits and does not deactivate products missing from config', async () => {
    const items = loadProductsFromConfig(configDir)
    await seedProducts(db, items)
    const first = items[0]
    if (!first) throw new Error('config has no products')
    await db
      .update(products)
      .set({ title: 'Edited by admin', priceTonNano: 42n, deliveryPayload: 'ADMIN-CODE' })
      .where(eq(products.slug, first.slug))
    await db.insert(products).values({ slug: 'admin-only', title: 'Admin only', priceTonNano: 1n })

    await seedProducts(db, items)

    const [edited] = await db.select().from(products).where(eq(products.slug, first.slug))
    expect(edited?.title).toBe('Edited by admin')
    expect(edited?.priceTonNano).toBe(42n)
    expect(edited?.deliveryPayload).toBe('ADMIN-CODE')
    const [adminOnly] = await db.select().from(products).where(eq(products.slug, 'admin-only'))
    expect(adminOnly?.isActive).toBe(true)
  })

  it('--overwrite re-syncs config fields by slug but keeps is_active and sort_order', async () => {
    const items = loadProductsFromConfig(configDir)
    await seedProducts(db, items)
    const first = items[0]
    if (!first) throw new Error('config has no products')
    await db
      .update(products)
      .set({
        title: 'Edited by admin',
        priceTonNano: 42n,
        deliveryPayload: 'ADMIN-CODE',
        deliverInChat: !first.deliverInChat,
        isActive: false,
        sortOrder: 999,
      })
      .where(eq(products.slug, first.slug))

    const result = await seedProducts(db, items, { overwrite: true })
    expect(result).toEqual({ inserted: 0, updated: items.length, skipped: 0 })

    const [row] = await db.select().from(products).where(eq(products.slug, first.slug))
    expect(row?.title).toBe(first.title)
    expect(row?.priceTonNano).toBe(first.priceTonNano)
    expect(row?.deliveryPayload).toBe(first.deliveryPayload)
    expect(row?.deliverInChat).toBe(first.deliverInChat)
    expect(row?.isActive).toBe(false)
    expect(row?.sortOrder).toBe(999)
  })
})
