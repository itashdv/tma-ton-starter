import { describe, expect, it, vi } from 'vitest'

import {
  attachPayment,
  cancelOrder,
  createProduct,
  getAdminHealth,
  getOrder,
  listOrders,
  listPayments,
  listProducts,
  resendNotification,
  updateProduct,
} from './admin-api'
import type { ApiClient } from './api'

function client() {
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn() }
  api.get.mockResolvedValue({ ok: true })
  api.post.mockResolvedValue({ ok: true })
  api.patch.mockResolvedValue({ ok: true })
  return { api, typed: api as unknown as ApiClient }
}

describe('admin API wrappers', () => {
  it('reads and writes the catalogue', async () => {
    const { api, typed } = client()
    await listProducts(typed)
    expect(api.get).toHaveBeenCalledWith('/admin/products')

    await createProduct(typed, { slug: 'guide', title: 'Guide', priceTonNano: '1500000000' })
    expect(api.post).toHaveBeenCalledWith('/admin/products', {
      slug: 'guide',
      title: 'Guide',
      priceTonNano: '1500000000',
    })

    await updateProduct(typed, 'p1', { imageUrl: null, isActive: false })
    expect(api.patch).toHaveBeenCalledWith('/admin/products/p1', {
      imageUrl: null,
      isActive: false,
    })
  })

  it('builds the orders query without empty values', async () => {
    const { api, typed } = client()
    await listOrders(typed)
    expect(api.get).toHaveBeenLastCalledWith('/admin/orders')

    await listOrders(typed, { status: '', cursor: null })
    expect(api.get).toHaveBeenLastCalledWith('/admin/orders')

    await listOrders(typed, { status: 'paid', cursor: 'abc', limit: 20 })
    expect(api.get).toHaveBeenLastCalledWith('/admin/orders?status=paid&cursor=abc&limit=20')

    await getOrder(typed, '0123456789abcdef')
    expect(api.get).toHaveBeenLastCalledWith('/admin/orders/0123456789abcdef')
  })

  it('posts order actions with the expected bodies', async () => {
    const { api, typed } = client()
    await cancelOrder(typed, '0123456789abcdef')
    expect(api.post).toHaveBeenLastCalledWith('/admin/orders/0123456789abcdef/cancel', {})

    await cancelOrder(typed, '0123456789abcdef', 'duplicate')
    expect(api.post).toHaveBeenLastCalledWith('/admin/orders/0123456789abcdef/cancel', {
      note: 'duplicate',
    })

    await resendNotification(typed, '0123456789abcdef')
    expect(api.post).toHaveBeenLastCalledWith(
      '/admin/orders/0123456789abcdef/resend-notification',
      {},
    )
  })

  it('lists payments with a filter and attaches exactly { orderId, force }', async () => {
    const { api, typed } = client()
    await listPayments(typed, { status: 'unmatched', cursor: 'abc' })
    expect(api.get).toHaveBeenLastCalledWith('/admin/payments?status=unmatched&cursor=abc')

    await attachPayment(typed, 'pay-1', { orderId: '0123456789abcdef', force: true })
    expect(api.post).toHaveBeenLastCalledWith('/admin/payments/pay-1/attach', {
      orderId: '0123456789abcdef',
      force: true,
    })
  })

  it('escapes ids used as path segments', async () => {
    const { api, typed } = client()
    await getOrder(typed, 'a/b?c')
    expect(api.get).toHaveBeenLastCalledWith('/admin/orders/a%2Fb%3Fc')
  })

  it('reads the health report', async () => {
    const { api, typed } = client()
    await getAdminHealth(typed)
    expect(api.get).toHaveBeenCalledWith('/admin/health')
  })
})
