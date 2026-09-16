import { formatUnits } from '@tma/shared'

import { shopConfig } from './shop-config'

/** Amounts arrive as digit strings in the smallest units and are never parsed into a number. */

export const TON_DECIMALS = 9

export function usdtDecimals(): number {
  return shopConfig.usdt?.decimals ?? 6
}

export function usdtLabel(): string {
  return shopConfig.usdt?.label ?? 'USDT'
}

export function formatAmount(currency: 'TON' | 'USDT', amount: string | bigint): string {
  const units = typeof amount === 'bigint' ? amount : BigInt(amount)
  return currency === 'TON'
    ? `${formatUnits(units, TON_DECIMALS)} TON`
    : `${formatUnits(units, usdtDecimals())} ${usdtLabel()}`
}

export function formatDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
}
