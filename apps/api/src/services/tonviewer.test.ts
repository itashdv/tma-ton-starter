import { Address } from '@ton/core'
import { describe, expect, it } from 'vitest'

import {
  displayAddress,
  tonviewerAddressUrl,
  tonviewerBase,
  tonviewerTransactionUrl,
} from './tonviewer'

const RAW = `0:${'11'.repeat(32)}`
const HASH = 'a'.repeat(64)

describe('tonviewer links', () => {
  it('picks the host by network', () => {
    expect(tonviewerBase('mainnet')).toBe('https://tonviewer.com')
    expect(tonviewerBase('testnet')).toBe('https://testnet.tonviewer.com')
    expect(tonviewerTransactionUrl('testnet', HASH)).toBe(
      `https://testnet.tonviewer.com/transaction/${HASH}`,
    )
  })

  it('shows wallets non-bounceable and contracts bounceable, with the testnet flag', () => {
    const address = Address.parseRaw(RAW)
    expect(displayAddress(RAW, { contract: false, network: 'testnet' })).toBe(
      address.toString({ bounceable: false, testOnly: true }),
    )
    expect(displayAddress(RAW, { contract: true, network: 'mainnet' })).toBe(
      address.toString({ bounceable: true, testOnly: false }),
    )
    expect(displayAddress(RAW, { contract: false, network: 'testnet' })?.startsWith('0Q')).toBe(
      true,
    )
    expect(displayAddress(RAW, { contract: true, network: 'testnet' })?.startsWith('kQ')).toBe(true)
  })

  it('builds an address link and refuses junk instead of linking to nowhere', () => {
    expect(tonviewerAddressUrl(RAW, { contract: false, network: 'mainnet' })).toBe(
      `https://tonviewer.com/${Address.parseRaw(RAW).toString({ bounceable: false })}`,
    )
    expect(displayAddress('not-an-address', { contract: false, network: 'mainnet' })).toBeNull()
    expect(tonviewerAddressUrl('0:AA', { contract: false, network: 'mainnet' })).toBeNull()
  })
})
