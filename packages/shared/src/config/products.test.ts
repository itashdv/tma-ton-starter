import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import { parseProductsConfig, productsConfigSchema } from './products'
import { parseShopConfig, shopUsdtDecimals } from './shop'

const configDir = new URL('../../../../config/', import.meta.url)
const shippedShop = parseShopConfig(
  JSON.parse(readFileSync(new URL('shop.json', configDir), 'utf8')),
)
const shippedProducts = JSON.parse(
  readFileSync(new URL('products.json', configDir), 'utf8'),
) as unknown

const options = { usdtDecimals: 6 }

function issuesOf(input: unknown, opts = options): string[] {
  const result = productsConfigSchema(opts).safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
}

describe('products.json schema', () => {
  it('accepts the shipped catalogue', () => {
    const products = parseProductsConfig(shippedProducts, {
      usdtDecimals: shopUsdtDecimals(shippedShop),
    })
    expect(products.length).toBeGreaterThan(0)
    for (const product of products) {
      expect(product.priceTonNano !== null || product.priceUsdtUnits !== null).toBe(true)
    }
  })

  it('converts prices into smallest units using the configured decimals', () => {
    const [product] = parseProductsConfig(
      [{ slug: 'a', title: 'A', priceTon: '1.5', priceUsdt: '12.345678' }],
      { usdtDecimals: 6 },
    )
    expect(product?.priceTonNano).toBe(1_500_000_000n)
    expect(product?.priceUsdtUnits).toBe(12_345_678n)
    const [nine] = parseProductsConfig([{ slug: 'a', title: 'A', priceUsdt: '12.345678' }], {
      usdtDecimals: 9,
    })
    expect(nine?.priceUsdtUnits).toBe(12_345_678_000n)
  })

  it('applies defaults', () => {
    const [product] = parseProductsConfig([{ slug: 'a', title: 'A', priceTon: '1' }], options)
    expect(product).toEqual({
      slug: 'a',
      title: 'A',
      description: '',
      imageUrl: null,
      priceTonNano: 1_000_000_000n,
      priceUsdtUnits: null,
      deliveryPayload: null,
      deliverInChat: false,
      isActive: true,
      sortOrder: 0,
    })
  })

  it('keeps deliveryPayload as a string and deliverInChat as given', () => {
    const [product] = parseProductsConfig(
      [{ slug: 'a', title: 'A', priceTon: '1', deliveryPayload: 'CODE-1', deliverInChat: true }],
      options,
    )
    expect(product?.deliveryPayload).toBe('CODE-1')
    expect(product?.deliverInChat).toBe(true)
  })

  it('rejects a product without any price, with the index in the path', () => {
    const issues = issuesOf([
      { slug: 'a', title: 'A', priceTon: '1' },
      { slug: 'b', title: 'B' },
    ])
    expect(issues.some((issue) => issue.startsWith('1:'))).toBe(true)
    expect(() => parseProductsConfig([{ slug: 'b', title: 'B' }], options)).toThrowError(ZodError)
  })

  it('rejects numeric prices, zero prices and too many decimals', () => {
    expect(issuesOf([{ slug: 'a', title: 'A', priceTon: 1.5 }])).not.toEqual([])
    expect(issuesOf([{ slug: 'a', title: 'A', priceTon: '0' }])).toContainEqual(
      expect.stringContaining('0.priceTon'),
    )
    expect(issuesOf([{ slug: 'a', title: 'A', priceUsdt: '1.2345678' }])).toContainEqual(
      expect.stringContaining('0.priceUsdt'),
    )
    expect(
      issuesOf([{ slug: 'a', title: 'A', priceUsdt: '1.2345678' }], { usdtDecimals: 9 }),
    ).toEqual([])
  })

  it('rejects duplicate slugs, bad slugs and unknown keys', () => {
    expect(
      issuesOf([
        { slug: 'a', title: 'A', priceTon: '1' },
        { slug: 'a', title: 'B', priceTon: '1' },
      ]),
    ).toContainEqual(expect.stringContaining('1.slug'))
    expect(issuesOf([{ slug: 'Bad Slug', title: 'A', priceTon: '1' }])).not.toEqual([])
    expect(issuesOf([{ slug: 'a', title: 'A', priceTon: '1', price: '1' }])).not.toEqual([])
  })
})
