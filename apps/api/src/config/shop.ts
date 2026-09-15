import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  assertLocalesConsistent,
  parseI18nDict,
  parseProductsConfig,
  parseShopConfig,
  shopUsdtDecimals,
  type I18nDict,
  type ShopConfig,
} from '@tma/shared'

export interface LoadedShopConfig {
  dir: string
  shop: ShopConfig
  i18n: Record<string, I18nDict>
  usdtDecimals: number
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    throw new Error(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    )
  }
}

/**
 * Reads and validates the whole config directory at startup (fail fast). products.json is
 * validated too even though the API serves products from the database, so a broken catalogue
 * file is noticed before the next seed.
 */
export function loadShopConfig(dir: string): LoadedShopConfig {
  const absolute = path.resolve(dir)
  const shop = parseShopConfig(readJson(path.join(absolute, 'shop.json')))
  const usdtDecimals = shopUsdtDecimals(shop)
  parseProductsConfig(readJson(path.join(absolute, 'products.json')), { usdtDecimals })
  const i18n: Record<string, I18nDict> = {}
  for (const locale of shop.locales) {
    i18n[locale] = parseI18nDict(readJson(path.join(absolute, 'i18n', `${locale}.json`)))
  }
  assertLocalesConsistent(i18n)
  return { dir: absolute, shop, i18n, usdtDecimals }
}
