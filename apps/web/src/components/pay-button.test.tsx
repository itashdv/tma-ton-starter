import type { CreateOrderResponse, MeResponse, ProductDto } from '@tma/shared'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as TonConnectUiReact from '@tonconnect/ui-react'
import { UserRejectsError, WalletWrongNetworkError } from '@tonconnect/ui-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MeProvider } from '@/app/me-context'
import { ApiError, SessionExpiredError } from '@/lib/api'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { PayButton } from './pay-button'

const state = vi.hoisted(() => ({
  wallet: null as { account: { address: string; chain: string } } | null,
  connectionRestored: true,
  openModal: vi.fn(async () => {}),
  sendTransaction: vi.fn(async (_request: { messages: unknown; network: string }) => ({
    boc: 'te6ccsigned',
  })),
  push: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@tonconnect/ui-react', async (importOriginal) => {
  const actual = await importOriginal<typeof TonConnectUiReact>()
  return {
    ...actual,
    useTonWallet: () => state.wallet,
    useIsConnectionRestored: () => state.connectionRestored,
    useTonConnectUI: () => [
      { openModal: state.openModal, sendTransaction: state.sendTransaction },
      vi.fn(),
    ],
  }
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('@/lib/use-api', () => {
  const api = { post: state.post, get: state.get }
  return { useApi: () => api }
})

const locale = shopConfig.defaultLocale
const TESTNET = '-3'

const product: ProductDto = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'guide',
  title: 'Guide',
  description: '',
  imageUrl: null,
  priceTonNano: '1500000000',
  priceUsdtUnits: null,
  sortOrder: 0,
}

const orderResponse: CreateOrderResponse = {
  order: {
    id: '0123456789abcdef',
    status: 'pending',
    currency: 'TON',
    amount: '1500000000',
    productId: product.id,
    productTitle: 'Guide',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    paidAt: null,
    paidLate: false,
    submittedAt: null,
    delivery: null,
  },
  payment: {
    network: TESTNET,
    comment: '0123456789abcdef',
    messages: [{ address: '0QAB', amount: '1500000000', payload: 'te6cckEB' }],
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    validSeconds: 300,
    jettonMaster: null,
  },
}

const meResponse = {
  user: { allowsWriteToPm: true, languageCode: locale },
  tonNetworkId: TESTNET,
  network: 'testnet',
} as unknown as MeResponse

beforeEach(() => {
  state.wallet = null
  state.connectionRestored = true
  state.openModal.mockClear()
  state.sendTransaction.mockReset().mockResolvedValue({ boc: 'te6ccsigned' })
  state.push.mockClear()
  state.post.mockReset().mockResolvedValue(orderResponse)
  state.get.mockReset().mockResolvedValue(meResponse)
})

function renderButton() {
  return render(
    <MeProvider>
      <PayButton product={product} currency="TON" amount="1500000000" />
    </MeProvider>,
  )
}

async function ready() {
  await waitFor(() => expect(state.get).toHaveBeenCalledWith('/me'))
}

describe('PayButton', () => {
  it('opens the wallet modal while no wallet is connected', async () => {
    renderButton()
    await ready()
    await userEvent.click(screen.getByRole('button', { name: t(locale, 'checkout.connect') }))
    expect(state.openModal).toHaveBeenCalledOnce()
    expect(state.post).not.toHaveBeenCalled()
  })

  it('waits for a stored connection instead of offering to connect again', async () => {
    state.connectionRestored = false
    renderButton()
    await ready()
    expect(screen.getByRole('button')).toBeDisabled()
    await userEvent.click(screen.getByRole('button'))
    expect(state.openModal).not.toHaveBeenCalled()
  })

  it('creates the order, sends the server messages and opens the order page', async () => {
    state.wallet = { account: { address: '0:payer', chain: TESTNET } }
    renderButton()
    await ready()
    expect(screen.getByRole('button').textContent).toContain('1.5 TON')
    await userEvent.click(screen.getByRole('button'))

    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/orders/0123456789abcdef'))
    expect(state.post).toHaveBeenNthCalledWith(1, '/orders', {
      productId: product.id,
      currency: 'TON',
      walletAddress: '0:payer',
    })
    // The wallet receives exactly the messages the API produced.
    const request = state.sendTransaction.mock.calls[0]?.[0]
    expect(request?.messages).toEqual(orderResponse.payment.messages)
    expect(request?.network).toBe(TESTNET)
    expect(state.post).toHaveBeenNthCalledWith(2, '/orders/0123456789abcdef/submitted', {
      boc: 'te6ccsigned',
    })
  })

  it('refuses a wallet on another network before creating an order', async () => {
    state.wallet = { account: { address: '0:payer', chain: '-239' } }
    renderButton()
    await ready()
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t(locale, 'checkout.wrongNetwork')),
    )
    // No order row is burned for a payment the wallet would refuse anyway.
    expect(state.post).not.toHaveBeenCalled()
    expect(state.sendTransaction).not.toHaveBeenCalled()
  })

  it('stays on the page and explains a rejection', async () => {
    state.wallet = { account: { address: '0:payer', chain: TESTNET } }
    state.sendTransaction.mockRejectedValue(new UserRejectsError())
    renderButton()
    await ready()
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(t(locale, 'checkout.declined')),
    )
    expect(state.push).not.toHaveBeenCalled()
    expect(state.post).toHaveBeenCalledOnce() // no submitted call for a declined payment
  })

  it('explains a wrong network reported by the wallet', async () => {
    state.wallet = { account: { address: '0:payer', chain: TESTNET } }
    state.sendTransaction.mockRejectedValue(
      new WalletWrongNetworkError('wrong network', {
        cause: { expectedChainId: '-239', actualChainId: TESTNET },
      }),
    )
    renderButton()
    await ready()
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t(locale, 'checkout.wrongNetwork')),
    )
  })

  it('tells the user to reopen the app when the session expired', async () => {
    state.wallet = { account: { address: '0:payer', chain: TESTNET } }
    state.post.mockRejectedValue(new SessionExpiredError(401, 'initdata_expired', 'too old'))
    renderButton()
    await ready()
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t(locale, 'error.sessionExpired')),
    )
    expect(state.sendTransaction).not.toHaveBeenCalled()
  })

  it('explains the open order limit instead of a generic failure', async () => {
    state.wallet = { account: { address: '0:payer', chain: TESTNET } }
    state.post.mockRejectedValue(new ApiError(409, 'order_limit', 'too many'))
    renderButton()
    await ready()
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t(locale, 'checkout.orderLimit')),
    )
  })

  it('reports any other failure without navigating', async () => {
    state.wallet = { account: { address: '0:payer', chain: TESTNET } }
    state.post.mockRejectedValue(new Error('boom'))
    renderButton()
    await ready()
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t(locale, 'checkout.failed')),
    )
    expect(state.sendTransaction).not.toHaveBeenCalled()
    expect(state.push).not.toHaveBeenCalled()
  })
})
