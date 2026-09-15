import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { assertLocalesConsistent, parseI18nDict, translate } from './i18n'
import { parseShopConfig } from './shop'

const configDir = new URL('../../../../config/', import.meta.url)
const shop = parseShopConfig(JSON.parse(readFileSync(new URL('shop.json', configDir), 'utf8')))

function loadLocale(locale: string) {
  return parseI18nDict(JSON.parse(readFileSync(new URL(`i18n/${locale}.json`, configDir), 'utf8')))
}

describe('i18n dictionaries', () => {
  it('ship one file per configured locale with identical key sets', () => {
    const dicts = Object.fromEntries(shop.locales.map((locale) => [locale, loadLocale(locale)]))
    expect(() => assertLocalesConsistent(dicts)).not.toThrow()
  })

  it('contain the notification template with an orderId placeholder', () => {
    for (const locale of shop.locales) {
      const dict = loadLocale(locale)
      expect(dict['notify.paid']).toContain('{{orderId}}')
    }
  })

  it('reports missing keys per locale', () => {
    expect(() => assertLocalesConsistent({ ru: { a: '1', b: '2' }, en: { a: '1' } })).toThrowError(
      /en: missing b/,
    )
  })

  it('rejects non-string values and odd keys', () => {
    expect(() => parseI18nDict({ 'a.b': 1 })).toThrow()
    expect(() => parseI18nDict({ 'a b': 'x' })).toThrow()
  })

  it('substitutes placeholders and falls back to the key', () => {
    const dict = { 'notify.paid': 'Order {{orderId}} paid: {{ product }}' }
    expect(translate(dict, 'notify.paid', { orderId: 'abc', product: 'Guide' })).toBe(
      'Order abc paid: Guide',
    )
    expect(translate(dict, 'notify.paid', { orderId: 'abc' })).toBe('Order abc paid: {{ product }}')
    expect(translate(dict, 'missing.key')).toBe('missing.key')
  })
})
