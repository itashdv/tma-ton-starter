import { products, type Db } from '@tma/db'

import { signMockInitData, type MockUserOptions } from '../../src/auth/sign-init-data'
import { TEST_ENV } from './build-app'

export const TEST_BOT_TOKEN = TEST_ENV.TELEGRAM_BOT_TOKEN ?? '123456:TEST'

/** `Authorization: tma <signed init data>` for a fake user. */
export function authHeader(options: MockUserOptions = {}): string {
  return `tma ${signMockInitData(TEST_BOT_TOKEN, options)}`
}

export interface SeedProductOptions {
  slug?: string
  title?: string
  priceTonNano?: bigint | null
  priceUsdtUnits?: bigint | null
  deliveryPayload?: string | null
  deliverInChat?: boolean
  isActive?: boolean
  sortOrder?: number
}

export async function seedProduct(db: Db, options: SeedProductOptions = {}) {
  const [row] = await db
    .insert(products)
    .values({
      slug: options.slug ?? 'guide',
      title: options.title ?? 'Guide',
      description: 'A digital good',
      priceTonNano: options.priceTonNano === undefined ? 1_500_000_000n : options.priceTonNano,
      priceUsdtUnits: options.priceUsdtUnits === undefined ? 5_000_000n : options.priceUsdtUnits,
      deliveryPayload: options.deliveryPayload ?? 'https://example.com/download',
      deliverInChat: options.deliverInChat ?? false,
      isActive: options.isActive ?? true,
      sortOrder: options.sortOrder ?? 0,
    })
    .returning()
  if (!row) throw new Error('product not inserted')
  return row
}
