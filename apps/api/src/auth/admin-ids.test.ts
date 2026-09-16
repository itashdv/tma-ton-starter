import { describe, expect, it } from 'vitest'

import { isAdminId } from './admin-ids'

describe('isAdminId', () => {
  it('denies everyone when the list is empty', () => {
    expect(isAdminId(new Set(), 279058397)).toBe(false)
    expect(isAdminId(new Set(), 0)).toBe(false)
  })

  it('compares as strings so ids above 2^31 work', () => {
    const big = 2 ** 40 + 7
    const ids = new Set(['279058397', String(big)])
    expect(isAdminId(ids, 279058397)).toBe(true)
    expect(isAdminId(ids, big)).toBe(true)
    expect(isAdminId(ids, BigInt(big))).toBe(true)
    expect(isAdminId(ids, 1)).toBe(false)
  })
})
