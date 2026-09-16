import { describe, expect, it } from 'vitest'

import { formatAmount, usdtDecimals, usdtLabel } from './format'
import { shopConfig } from './shop-config'

describe('formatAmount', () => {
  it('formats nanoTON', () => {
    expect(formatAmount('TON', '1500000000')).toBe('1.5 TON')
    expect(formatAmount('TON', 1n)).toBe('0.000000001 TON')
    expect(formatAmount('TON', '3000000000')).toBe('3 TON')
  })

  it('formats the jetton with the label and decimals from config/shop.json', () => {
    // Asserted against the config file, not against the helpers, so a fallback cannot hide a
    // misread config: a client project with another label or decimals must fail here.
    expect(shopConfig.usdt).toBeDefined()
    expect(usdtDecimals()).toBe(shopConfig.usdt?.decimals)
    expect(usdtLabel()).toBe(shopConfig.usdt?.label)
    expect(usdtDecimals()).toBe(6)
    expect(usdtLabel()).toBe('USDT')
    expect(formatAmount('USDT', '12340000')).toBe('12.34 USDT')
    expect(formatAmount('USDT', '1000000')).toBe('1 USDT')
  })

  it('never turns an amount into a number', () => {
    expect(formatAmount('TON', '9007199254740993000000000')).toBe('9007199254740993 TON')
  })
})
