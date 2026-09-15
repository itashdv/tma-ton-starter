import { describe, expect, it } from 'vitest'

import { dictionaries, pickLocale, t } from './i18n'
import { shopConfig } from './shop-config'

describe('pickLocale', () => {
  it('returns a configured locale and falls back to the default otherwise', () => {
    for (const locale of shopConfig.locales) {
      expect(pickLocale(locale)).toBe(locale)
    }
    expect(pickLocale('de')).toBe(shopConfig.defaultLocale)
    expect(pickLocale(null)).toBe(shopConfig.defaultLocale)
    expect(pickLocale(undefined)).toBe(shopConfig.defaultLocale)
    expect(pickLocale('')).toBe(shopConfig.defaultLocale)
  })

  it('ignores inherited object keys such as toString and __proto__', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(pickLocale(key), key).toBe(shopConfig.defaultLocale)
    }
    expect(t('toString', 'catalog.title')).toBe(t(shopConfig.defaultLocale, 'catalog.title'))
  })
})

describe('dictionaries', () => {
  it('bundles every locale listed in config/shop.json', () => {
    expect(Object.keys(dictionaries).sort()).toEqual([...shopConfig.locales].sort())
  })
})
