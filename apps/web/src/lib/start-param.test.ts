import { describe, expect, it } from 'vitest'

import { parseStartParam } from './start-param'

describe('parseStartParam', () => {
  it('recognises an order deep link', () => {
    expect(parseStartParam('order_0123456789abcdef')).toEqual({
      kind: 'order',
      id: '0123456789abcdef',
    })
  })

  it('recognises a product deep link', () => {
    expect(parseStartParam('product_ton-starter-guide')).toEqual({
      kind: 'product',
      slug: 'ton-starter-guide',
    })
  })

  it('ignores anything else, including attempts to steer authorisation', () => {
    for (const value of [
      'admin',
      'order_ORDER',
      'order_short',
      'product_Bad Slug',
      '',
      null,
      undefined,
    ]) {
      expect(parseStartParam(value), String(value)).toEqual({ kind: 'none' })
    }
  })
})
