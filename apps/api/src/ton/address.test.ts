import { Address } from '@ton/core'
import { describe, expect, it } from 'vitest'

import { addressesEqual, parseAddress, toFriendly, toRawAddress, tryParseAddress } from './address'

const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const USDT_RAW = '0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE'

describe('parseAddress', () => {
  it('normalises every input form to one uppercase raw string', () => {
    for (const form of [
      USDT,
      USDT_RAW,
      USDT_RAW.toLowerCase(),
      Address.parse(USDT).toString({ bounceable: false }),
    ]) {
      expect(parseAddress(form).raw, form).toBe(USDT_RAW)
    }
  })

  it('reports the flags of a friendly form and null for raw input', () => {
    expect(parseAddress(USDT)).toMatchObject({ bounceable: true, testOnly: false })
    const testnet = Address.parse(USDT).toString({ testOnly: true, bounceable: false })
    expect(parseAddress(testnet)).toMatchObject({ bounceable: false, testOnly: true })
    expect(parseAddress(USDT_RAW)).toMatchObject({ bounceable: null, testOnly: null })
  })

  it('rejects malformed values instead of truncating them', () => {
    for (const bad of [
      `${USDT_RAW}0`,
      `${USDT_RAW}zz`,
      `abc:${USDT_RAW.slice(2)}`,
      '',
      'not-an-address',
    ]) {
      expect(() => parseAddress(bad), bad).toThrow()
      expect(tryParseAddress(bad), bad).toBeNull()
    }
  })
})

describe('addressesEqual', () => {
  it('ignores the form and the hex case', () => {
    expect(addressesEqual(USDT, USDT_RAW.toLowerCase())).toBe(true)
    expect(addressesEqual(USDT, Address.parse(USDT).toString({ bounceable: false }))).toBe(true)
    expect(addressesEqual(USDT, `0:${'0'.repeat(64)}`)).toBe(false)
    expect(addressesEqual(USDT, 'garbage')).toBe(false)
  })
})

describe('toFriendly / toRawAddress', () => {
  it('builds the requested friendly form', () => {
    const address = Address.parse(USDT)
    expect(toFriendly(address, { bounceable: true, testOnly: false })).toBe(USDT)
    expect(toFriendly(address, { bounceable: false, testOnly: false }).startsWith('UQ')).toBe(true)
    expect(toFriendly(address, { bounceable: true, testOnly: true }).startsWith('kQ')).toBe(true)
    expect(toFriendly(address, { bounceable: false, testOnly: true }).startsWith('0Q')).toBe(true)
    expect(toRawAddress(address)).toBe(USDT_RAW)
  })
})
