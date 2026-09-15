import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseShopConfig, shopConfigSchema, shopUsdtDecimals, shopUsdtLabel } from './shop'

const configDir = new URL('../../../../config/', import.meta.url)
const shipped = JSON.parse(readFileSync(new URL('shop.json', configDir), 'utf8')) as unknown

const valid = {
  name: 'Shop',
  defaultLocale: 'ru',
  locales: ['ru', 'en'],
  currencies: ['TON', 'USDT'],
  usdt: { label: 'USDT', decimals: 6 },
  branding: { accentColor: '#0098EA', icon: 'icon-180.png' },
}

describe('shop.json schema', () => {
  it('accepts the shipped config', () => {
    const shop = parseShopConfig(shipped)
    expect(shop.name.length).toBeGreaterThan(0)
    expect(shop.locales).toContain(shop.defaultLocale)
    expect(shopUsdtDecimals(shop)).toBe(6)
    expect(shopUsdtLabel(shop)).toBe('USDT')
  })

  it('requires the listed fields and applies defaults', () => {
    const shop = parseShopConfig(valid)
    expect(shop.description).toBe('')
    expect(shop.support).toBeUndefined()
    const result = shopConfigSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'))
      for (const required of ['name', 'defaultLocale', 'locales', 'currencies', 'branding']) {
        expect(paths).toContain(required)
      }
    }
  })

  it('requires the usdt block when USDT is enabled', () => {
    const { usdt: _usdt, ...withoutUsdt } = valid
    const result = shopConfigSchema.safeParse(withoutUsdt)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('usdt')
    }
    expect(shopConfigSchema.safeParse({ ...withoutUsdt, currencies: ['TON'] }).success).toBe(true)
  })

  it('validates usdt.decimals', () => {
    expect(
      shopConfigSchema.safeParse({ ...valid, usdt: { label: 'USDT', decimals: 6.5 } }).success,
    ).toBe(false)
    expect(
      shopConfigSchema.safeParse({ ...valid, usdt: { label: 'USDT', decimals: 19 } }).success,
    ).toBe(false)
    expect(
      shopConfigSchema.safeParse({ ...valid, usdt: { label: 'USDT', decimals: 9 } }).success,
    ).toBe(true)
  })

  it('requires defaultLocale to be one of locales and rejects duplicates', () => {
    expect(shopConfigSchema.safeParse({ ...valid, defaultLocale: 'de' }).success).toBe(false)
    expect(shopConfigSchema.safeParse({ ...valid, locales: ['ru', 'ru'] }).success).toBe(false)
    expect(shopConfigSchema.safeParse({ ...valid, currencies: ['TON', 'TON'] }).success).toBe(false)
    expect(shopConfigSchema.safeParse({ ...valid, currencies: [] }).success).toBe(false)
    expect(shopConfigSchema.safeParse({ ...valid, currencies: ['EUR'] }).success).toBe(false)
  })

  it('rejects unknown keys and malformed branding', () => {
    expect(shopConfigSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
    expect(
      shopConfigSchema.safeParse({
        ...valid,
        branding: { accentColor: 'blue', icon: 'icon-180.png' },
      }).success,
    ).toBe(false)
    expect(
      shopConfigSchema.safeParse({
        ...valid,
        branding: { accentColor: '#0098EA', icon: 'icon.svg' },
      }).success,
    ).toBe(false)
  })
})
