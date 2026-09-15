import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  parseProductsConfig,
  parseShopConfig,
  shopUsdtDecimals,
  type ProductSeed,
} from '@tma/shared'
import { sql } from 'drizzle-orm'

import { products, type Db } from './index'

export interface SeedOptions {
  /** Re-sync config-owned fields (title, description, image, prices, delivery) by slug. */
  overwrite?: boolean
}

export interface SeedResult {
  inserted: number
  updated: number
  skipped: number
}

/** Reads config/shop.json and config/products.json and returns products in DB units. */
export function loadProductsFromConfig(configDir: string): ProductSeed[] {
  const shop = parseShopConfig(
    JSON.parse(readFileSync(path.join(configDir, 'shop.json'), 'utf8')) as unknown,
  )
  const raw = JSON.parse(readFileSync(path.join(configDir, 'products.json'), 'utf8')) as unknown
  return parseProductsConfig(raw, { usdtDecimals: shopUsdtDecimals(shop) })
}

/**
 * Insert-only by default: rows that already exist by slug are left untouched so that admin
 * edits survive repeated seeds. With `overwrite` the config-owned columns are re-synced;
 * `is_active` and `sort_order` are never overwritten.
 */
export async function seedProducts(
  db: Db,
  items: ProductSeed[],
  options: SeedOptions = {},
): Promise<SeedResult> {
  const result: SeedResult = { inserted: 0, updated: 0, skipped: 0 }
  for (const item of items) {
    const values = {
      slug: item.slug,
      title: item.title,
      description: item.description,
      imageUrl: item.imageUrl,
      priceTonNano: item.priceTonNano,
      priceUsdtUnits: item.priceUsdtUnits,
      deliveryPayload: item.deliveryPayload,
      deliverInChat: item.deliverInChat,
      isActive: item.isActive,
      sortOrder: item.sortOrder,
    }
    if (options.overwrite) {
      const rows = await db
        .insert(products)
        .values(values)
        .onConflictDoUpdate({
          target: products.slug,
          set: {
            title: values.title,
            description: values.description,
            imageUrl: values.imageUrl,
            priceTonNano: values.priceTonNano,
            priceUsdtUnits: values.priceUsdtUnits,
            deliveryPayload: values.deliveryPayload,
            deliverInChat: values.deliverInChat,
            updatedAt: sql`now()`,
          },
        })
        // xmax = 0 only for a freshly inserted row; an updated row has a non-zero xmax.
        .returning({ wasInsert: sql<boolean>`(xmax = 0)` })
      if (rows[0]?.wasInsert) result.inserted += 1
      else result.updated += 1
    } else {
      const rows = await db
        .insert(products)
        .values(values)
        .onConflictDoNothing({ target: products.slug })
        .returning({ id: products.id })
      if (rows.length > 0) result.inserted += 1
      else result.skipped += 1
    }
  }
  return result
}
