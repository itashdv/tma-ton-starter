import type { AdminOrderDto } from '@tma/shared'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { OrdersTable } from './orders-table'

const state = vi.hoisted(() => ({ get: vi.fn() }))

// The real useApi memoises the client; a new object per render would restart the list effect.
vi.mock('@/lib/use-api', () => {
  const api = { get: state.get, post: vi.fn(), patch: vi.fn() }
  return { useApi: () => api }
})

const locale = shopConfig.defaultLocale
const now = new Date().toISOString()

const order = (overrides: Partial<AdminOrderDto>): AdminOrderDto => ({
  id: '0123456789abcdef',
  status: 'paid',
  currency: 'TON',
  amount: '1500000000',
  productId: '11111111-1111-4111-8111-111111111111',
  productTitle: 'Guide',
  createdAt: now,
  expiresAt: now,
  paidAt: now,
  paidLate: false,
  submittedAt: null,
  delivery: null,
  userId: '42',
  userFirstName: 'Ann',
  userUsername: 'ann',
  jettonMaster: null,
  merchantAddress: 'EQmerchant',
  payerAddress: null,
  extMsgHash: null,
  cancelledAt: null,
  cancelledBy: null,
  adminNote: null,
  updatedAt: now,
  ...overrides,
})

beforeEach(() => {
  state.get.mockReset()
})

describe('OrdersTable', () => {
  it('renders rows with the status text and the formatted amount', async () => {
    state.get.mockResolvedValue({ orders: [order({})], nextCursor: null })
    render(<OrdersTable />)
    const row = await screen.findByRole('link', { name: /Guide/ })
    expect(row).toHaveAttribute('href', '/admin/orders/0123456789abcdef')
    expect(row).toHaveTextContent('1.5 TON')
    expect(row).toHaveTextContent(t(locale, 'admin.orderStatus.paid'))
    expect(row).toHaveTextContent('Ann @ann')
    expect(state.get).toHaveBeenCalledWith('/admin/orders')
  })

  it('reloads the list when the status filter changes', async () => {
    state.get.mockResolvedValue({ orders: [], nextCursor: null })
    render(<OrdersTable />)
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/admin/orders'))
    await userEvent.selectOptions(screen.getByRole('combobox'), 'paid')
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/admin/orders?status=paid'))
    expect(await screen.findByText(t(locale, 'admin.empty'))).toBeInTheDocument()
  })

  it('loads the next page with the cursor and appends it', async () => {
    state.get
      .mockResolvedValueOnce({ orders: [order({})], nextCursor: 'abc' })
      .mockResolvedValueOnce({
        orders: [order({ id: 'zzzzzzzzzzzzzzzz', productTitle: 'Second' })],
        nextCursor: null,
      })
    render(<OrdersTable />)
    const more = await screen.findByRole('button', { name: t(locale, 'admin.loadMore') })
    await userEvent.click(more)
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/admin/orders?cursor=abc'))
    await screen.findByRole('link', { name: /Second/ })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(
      screen.queryByRole('button', { name: t(locale, 'admin.loadMore') }),
    ).not.toBeInTheDocument()
  })

  it('reports a failed load', async () => {
    state.get.mockRejectedValue(new Error('offline'))
    render(<OrdersTable />)
    expect(await screen.findByRole('alert')).toHaveTextContent(t(locale, 'admin.loadFailed'))
  })
})
