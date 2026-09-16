import type { OrderDto } from '@tma/shared'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionExpiredError } from '@/lib/api'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { ORDER_POLL_MS, OrderStatus } from './order-status'

const state = vi.hoisted(() => ({ get: vi.fn() }))
// The real useApi memoises the client; a new object per render would restart the polling effect.
vi.mock('@/lib/use-api', () => {
  const api = { get: state.get, post: vi.fn() }
  return { useApi: () => api }
})

const locale = shopConfig.defaultLocale

const order = (overrides: Partial<OrderDto> = {}): OrderDto => ({
  id: '0123456789abcdef',
  status: 'pending',
  currency: 'TON',
  amount: '1500000000',
  productId: '11111111-1111-4111-8111-111111111111',
  productTitle: 'Guide',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
  paidAt: null,
  paidLate: false,
  submittedAt: null,
  delivery: null,
  ...overrides,
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  state.get.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OrderStatus', () => {
  it('polls while the order is pending and stops once it is paid', async () => {
    state.get
      .mockResolvedValueOnce({ order: order() })
      .mockResolvedValueOnce({ order: order() })
      .mockResolvedValue({
        order: order({
          status: 'paid',
          paidAt: new Date().toISOString(),
          delivery: { payload: 'CODE-1', deliverInChat: true },
        }),
      })

    render(<OrderStatus orderId="0123456789abcdef" />)
    await waitFor(() =>
      expect(screen.getByTestId('order-status').textContent).toBe(t(locale, 'order.pending')),
    )
    expect(state.get).toHaveBeenCalledWith('/orders/0123456789abcdef')

    const afterFirstRender = state.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(ORDER_POLL_MS)
    expect(state.get.mock.calls.length).toBeGreaterThan(afterFirstRender)

    await vi.advanceTimersByTimeAsync(ORDER_POLL_MS)
    await waitFor(() =>
      expect(screen.getByTestId('order-status').textContent).toBe(t(locale, 'order.paid')),
    )
    expect(screen.getByTestId('order-delivery').textContent).toBe('CODE-1')

    // Once the order is paid the loop must stop: no further request is scheduled.
    const callsAfterPaid = state.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(ORDER_POLL_MS * 3)
    expect(state.get.mock.calls.length).toBe(callsAfterPaid)
  })

  it('shows the delivery payload only when the API sent one', async () => {
    state.get.mockResolvedValue({ order: order({ status: 'expired' }) })
    render(<OrderStatus orderId="0123456789abcdef" />)
    await waitFor(() =>
      expect(screen.getByTestId('order-status').textContent).toBe(t(locale, 'order.expired')),
    )
    expect(screen.queryByTestId('order-delivery')).not.toBeInTheDocument()
  })

  it('pauses while the tab is hidden', async () => {
    state.get.mockResolvedValue({ order: order() })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    render(<OrderStatus orderId="0123456789abcdef" />)
    await waitFor(() => expect(state.get).toHaveBeenCalled())
    const whileHidden = state.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(ORDER_POLL_MS * 3)
    expect(state.get.mock.calls.length).toBe(whileHidden)
    hidden.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(ORDER_POLL_MS)
    expect(state.get.mock.calls.length).toBeGreaterThan(whileHidden)
    hidden.mockRestore()
  })

  it('stops polling after unmount', async () => {
    state.get.mockResolvedValue({ order: order() })
    const { unmount } = render(<OrderStatus orderId="0123456789abcdef" />)
    await waitFor(() => expect(state.get).toHaveBeenCalled())
    unmount()
    const afterUnmount = state.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(ORDER_POLL_MS * 3)
    expect(state.get.mock.calls.length).toBe(afterUnmount)
  })

  it('reports a failure instead of spinning forever', async () => {
    state.get.mockRejectedValue(new Error('offline'))
    render(<OrderStatus orderId="0123456789abcdef" />)
    await waitFor(() => expect(screen.getByText(t(locale, 'order.failed'))).toBeInTheDocument())
  })

  it('recovers from a dropped connection instead of giving up for good', async () => {
    state.get
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ order: order({ status: 'paid' }) })
    render(<OrderStatus orderId="0123456789abcdef" />)
    await waitFor(() => expect(screen.getByText(t(locale, 'order.failed'))).toBeInTheDocument())

    await vi.advanceTimersByTimeAsync(ORDER_POLL_MS)
    await waitFor(() =>
      expect(screen.getByTestId('order-status').textContent).toBe(t(locale, 'order.paid')),
    )
    expect(screen.queryByText(t(locale, 'order.failed'))).not.toBeInTheDocument()
  })

  it('stops and asks to reopen the app when the session expired', async () => {
    state.get.mockRejectedValue(new SessionExpiredError(401, 'initdata_expired', 'too old'))
    render(<OrderStatus orderId="0123456789abcdef" />)
    await waitFor(() =>
      expect(screen.getByText(t(locale, 'error.sessionExpired'))).toBeInTheDocument(),
    )
    // Retrying cannot help: the init data of this launch is fixed.
    const calls = state.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(ORDER_POLL_MS * 3)
    expect(state.get.mock.calls.length).toBe(calls)
  })
})
