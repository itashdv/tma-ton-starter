import type { AdminPaymentDto } from '@tma/shared'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { PaymentsTable } from './payments-table'

const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

// The real useApi memoises the client; a new object per render would restart the list effect.
vi.mock('@/lib/use-api', () => {
  const api = { get: state.get, post: state.post, patch: vi.fn() }
  return { useApi: () => api }
})

const locale = shopConfig.defaultLocale
const now = new Date().toISOString()
const ORDER_ID = '0123456789abcdef'

const payment = (overrides: Partial<AdminPaymentDto>): AdminPaymentDto => ({
  id: 'pay-1',
  account: '0:merchant',
  txHash: 'abcd1234567890wxyz',
  txLt: '100',
  txNow: '1700000000',
  mcBlockSeqno: '1',
  traceId: null,
  currency: 'TON',
  jettonMaster: null,
  sourceWallet: null,
  amount: '1500000000',
  senderAddress: 'EQsender0000000000000000000000000000000000000000',
  comment: null,
  orderId: null,
  status: 'unmatched',
  reason: null,
  payerMismatch: false,
  attachedBy: null,
  createdAt: now,
  tonviewerUrl: 'https://testnet.tonviewer.com/transaction/abcd1234567890wxyz',
  senderUrl: 'https://testnet.tonviewer.com/EQsender',
  ...overrides,
})

const orderIdInput = () => screen.findByLabelText(t(locale, 'admin.orderId'))
const attachButton = () => screen.getByRole('button', { name: t(locale, 'admin.attach.submit') })
const forceBox = () => screen.queryByLabelText(t(locale, 'admin.attach.force'))

beforeEach(() => {
  state.get.mockReset()
  state.post.mockReset()
})

describe('PaymentsTable', () => {
  it('attaches an unmatched payment with { orderId, force: false }', async () => {
    state.get.mockResolvedValue({ payments: [payment({})], nextCursor: null })
    state.post.mockResolvedValue({
      payment: payment({ status: 'matched', orderId: ORDER_ID }),
      order: {},
    })
    render(<PaymentsTable />)
    const input = await orderIdInput()
    expect(input).toHaveAttribute('pattern', '[0-9a-hjkmnp-tv-z]{16}')
    expect(forceBox()).not.toBeInTheDocument()

    await userEvent.type(input, ORDER_ID)
    await userEvent.click(attachButton())
    await waitFor(() =>
      expect(state.post).toHaveBeenCalledWith('/admin/payments/pay-1/attach', {
        orderId: ORDER_ID,
        force: false,
      }),
    )
    // The row takes the API's word for its new state, so the attach form goes away.
    await waitFor(() =>
      expect(screen.queryByLabelText(t(locale, 'admin.orderId'))).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('link', { name: ORDER_ID })).toHaveAttribute(
      'href',
      `/admin/orders/${ORDER_ID}`,
    )
  })

  it('rejects a malformed order id without calling the API', async () => {
    state.get.mockResolvedValue({ payments: [payment({})], nextCursor: null })
    render(<PaymentsTable />)
    await userEvent.type(await orderIdInput(), 'not-an-order-id')
    await userEvent.click(attachButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      t(locale, 'admin.attach.orderIdInvalid'),
    )
    expect(state.post).not.toHaveBeenCalled()
  })

  it('offers force only for an underpaid row and sends it once ticked', async () => {
    state.get.mockResolvedValue({ payments: [payment({ status: 'underpaid' })], nextCursor: null })
    state.post
      .mockRejectedValueOnce(new ApiError(422, 'underpaid', 'below the order amount'))
      .mockResolvedValue({ payment: payment({ status: 'matched', orderId: ORDER_ID }), order: {} })
    render(<PaymentsTable />)
    await userEvent.type(await orderIdInput(), ORDER_ID)
    await userEvent.click(attachButton())
    await waitFor(() =>
      expect(state.post).toHaveBeenLastCalledWith('/admin/payments/pay-1/attach', {
        orderId: ORDER_ID,
        force: false,
      }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(t(locale, 'admin.attach.underpaid'))

    const box = forceBox()
    expect(box).not.toBeNull()
    if (!box) return
    await userEvent.click(box)
    await userEvent.click(attachButton())
    await waitFor(() =>
      expect(state.post).toHaveBeenLastCalledWith('/admin/payments/pay-1/attach', {
        orderId: ORDER_ID,
        force: true,
      }),
    )
  })

  it('explains a currency mismatch instead of offering force', async () => {
    state.get.mockResolvedValue({ payments: [payment({})], nextCursor: null })
    state.post.mockRejectedValue(new ApiError(422, 'currency_mismatch', 'USDT vs TON'))
    render(<PaymentsTable />)
    await userEvent.type(await orderIdInput(), ORDER_ID)
    await userEvent.click(attachButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      t(locale, 'admin.attach.currencyMismatch'),
    )
    expect(forceBox()).not.toBeInTheDocument()
  })

  it('has no attach controls on matched and ignored rows and shows why a row was ignored', async () => {
    state.get.mockResolvedValue({
      payments: [
        payment({ id: 'm', status: 'matched', orderId: ORDER_ID }),
        payment({
          id: 'i',
          status: 'ignored',
          reason: 'unknown jetton wallet',
          sourceWallet: 'EQsourcewallet',
        }),
      ],
      nextCursor: null,
    })
    render(<PaymentsTable />)
    expect(await screen.findByText('unknown jetton wallet')).toBeInTheDocument()
    expect(screen.getByText('EQsourcewallet')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(
      screen.queryByRole('button', { name: t(locale, 'admin.attach.submit') }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText(t(locale, 'admin.orderId'))).not.toBeInTheDocument()
  })

  it('links the shortened hash and the sender to the explorer', async () => {
    state.get.mockResolvedValue({ payments: [payment({})], nextCursor: null })
    render(<PaymentsTable />)
    const tx = await screen.findByRole('link', { name: 'abcd…wxyz' })
    expect(tx).toHaveAttribute(
      'href',
      'https://testnet.tonviewer.com/transaction/abcd1234567890wxyz',
    )
    expect(screen.getByRole('link', { name: 'EQse…0000' })).toHaveAttribute(
      'href',
      'https://testnet.tonviewer.com/EQsender',
    )
  })

  it('filters by status, including ignored, and pages with the cursor', async () => {
    state.get
      .mockResolvedValueOnce({ payments: [payment({})], nextCursor: 'abc' })
      .mockResolvedValueOnce({ payments: [payment({ id: 'pay-2' })], nextCursor: null })
      .mockResolvedValue({ payments: [], nextCursor: null })
    render(<PaymentsTable />)
    await userEvent.click(await screen.findByRole('button', { name: t(locale, 'admin.loadMore') }))
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/admin/payments?cursor=abc'))
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2))

    await userEvent.selectOptions(screen.getByRole('combobox'), 'ignored')
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/admin/payments?status=ignored'))
  })
})
