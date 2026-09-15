import { assertLocalesConsistent, parseI18nDict, translate, type I18nDict } from '@tma/shared'

import en from '../../../../config/i18n/en.json'
import ru from '../../../../config/i18n/ru.json'
import { shopConfig } from './shop-config'

/**
 * Dictionaries are bundled statically so that client components get them for free.
 * Adding a locale = adding config/i18n/<code>.json, listing it in shop.json and adding one
 * import line here (documented in config/README.md); the check below fails the build if they
 * get out of sync.
 */
const bundled: Record<string, I18nDict> = {
  ru: parseI18nDict(ru),
  en: parseI18nDict(en),
}

export const dictionaries: Record<string, I18nDict> = Object.fromEntries(
  shopConfig.locales.map((locale) => {
    const dict = bundled[locale]
    if (!dict) {
      throw new Error(
        `locale "${locale}" is listed in config/shop.json but not bundled in apps/web/src/lib/i18n.ts`,
      )
    }
    return [locale, dict]
  }),
)
assertLocalesConsistent(dictionaries)

export function pickLocale(candidate: string | null | undefined): string {
  if (candidate && Object.hasOwn(dictionaries, candidate)) return candidate
  return shopConfig.defaultLocale
}

export function t(locale: string, key: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[pickLocale(locale)] ?? {}
  return translate(dict, key, vars)
}
