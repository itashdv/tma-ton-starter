import type { ProductDto } from '@tma/shared'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { ProductList } from './product-list'

const state = vi.hoisted(() => ({ get: vi.fn() }))

// The real useApi memoises the client, so the mock must return a stable object too:
// a new object every render would restart every effect that depends on it.
vi.mock('@/lib/use-api', () => {
  const api = { get: state.get, post: vi.fn() }
  return { useApi: () => api }
})
vi.mock('./pay-button', () => ({
  PayButton: ({ currency, amount }: { currency: string; amount: string }) => (
    <button type="button">{`pay ${currency} ${amount}`}</button>
  ),
}))

const locale = shopConfig.defaultLocale

const product = (overrides: Partial<ProductDto>): ProductDto => ({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'guide',
  title: 'Guide',
  description: 'A digital good',
  imageUrl: null,
  priceTonNano: '1500000000',
  priceUsdtUnits: '5000000',
  sortOrder: 0,
  ...overrides,
})

beforeEach(() => {
  state.get.mockReset()
})

describe('ProductList', () => {
  it('shows the catalogue with both prices formatted', async () => {
    state.get.mockResolvedValue({ products: [product({})] })
    render(<ProductList />)
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Guide'),
    )
    expect(screen.getByText(/1\.5 TON/)).toBeInTheDocument()
    expect(screen.getByText(/5 USDT/)).toBeInTheDocument()
    expect(state.get).toHaveBeenCalledWith('/products', { auth: false })
  })

  it('offers a currency only when the product has that price', async () => {
    state.get.mockResolvedValue({ products: [product({ priceUsdtUnits: null })] })
    render(<ProductList />)
    await waitFor(() => expect(screen.getByRole('button', { name: /pay TON/ })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /pay USDT/ })).not.toBeInTheDocument()
  })

  it('shows an empty state and a failure state', async () => {
    state.get.mockResolvedValue({ products: [] })
    const { unmount } = render(<ProductList />)
    await waitFor(() => expect(screen.getByText(t(locale, 'catalog.empty'))).toBeInTheDocument())
    unmount()

    state.get.mockRejectedValue(new Error('offline'))
    render(<ProductList />)
    await waitFor(() => expect(screen.getByText(t(locale, 'catalog.failed'))).toBeInTheDocument())
  })
})
