import type { AdminProductDto } from '@tma/shared'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api'
import { usdtLabel } from '@/lib/format'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { ProductForm } from './product-form'

const locale = shopConfig.defaultLocale
const onSubmit = vi.fn<(input: unknown) => Promise<void>>()

// Whatever the configured jetton precision, "12.34" must become 1234 followed by the
// remaining decimal places, so the expected value is derived from config/shop.json.
const usdtDecimals = shopConfig.usdt?.decimals ?? 6
const USDT_12_34 = `1234${'0'.repeat(usdtDecimals - 2)}`

const field = (key: string) => screen.getByLabelText(t(locale, key))
const usdtField = () =>
  screen.getByLabelText(t(locale, 'admin.field.priceUsdt', { label: usdtLabel() }))
const submit = () => userEvent.click(screen.getByRole('button', { name: 'Save' }))

async function fillRequired() {
  await userEvent.type(field('admin.field.slug'), 'guide')
  await userEvent.type(field('admin.field.title'), 'Guide')
}

const product: AdminProductDto = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'guide',
  title: 'Guide',
  description: 'A digital good',
  imageUrl: null,
  priceTonNano: '1500000000',
  priceUsdtUnits: USDT_12_34,
  sortOrder: 3,
  deliveryPayload: 'KEY-1',
  deliverInChat: true,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

beforeEach(() => {
  onSubmit.mockReset().mockResolvedValue(undefined)
})

describe('ProductForm', () => {
  it('converts decimal prices into smallest units', async () => {
    render(<ProductForm onSubmit={onSubmit} submitLabel="Save" />)
    await fillRequired()
    await userEvent.type(field('admin.field.priceTon'), '1.5')
    await userEvent.type(usdtField(), '12.34')
    await submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'guide',
        title: 'Guide',
        priceTonNano: '1500000000',
        priceUsdtUnits: USDT_12_34,
      }),
    )
  })

  it('refuses a product without any price before calling the API', async () => {
    render(<ProductForm onSubmit={onSubmit} submitLabel="Save" />)
    await fillRequired()
    await submit()
    expect(await screen.findByText(t(locale, 'admin.priceRequired'))).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('rejects a comma as the decimal separator on the offending field', async () => {
    render(<ProductForm onSubmit={onSubmit} submitLabel="Save" />)
    await fillRequired()
    await userEvent.type(field('admin.field.priceTon'), '1,5')
    await submit()
    expect(await screen.findByText(t(locale, 'admin.priceInvalid'))).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('passes the delivery settings, the flags and the sort order through', async () => {
    render(<ProductForm onSubmit={onSubmit} submitLabel="Save" />)
    await fillRequired()
    await userEvent.type(field('admin.field.priceTon'), '2')
    await userEvent.type(field('admin.field.deliveryPayload'), 'KEY-123')
    await userEvent.click(field('admin.field.deliverInChat'))
    await userEvent.click(field('admin.field.isActive'))
    await userEvent.clear(field('admin.field.sortOrder'))
    await userEvent.type(field('admin.field.sortOrder'), '7')
    await submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        priceTonNano: '2000000000',
        priceUsdtUnits: null,
        deliveryPayload: 'KEY-123',
        deliverInChat: true,
        isActive: false,
        sortOrder: 7,
      }),
    )
  })

  it('shows the stored prices as decimals and keeps the slug read-only when editing', async () => {
    render(<ProductForm initial={product} onSubmit={onSubmit} submitLabel="Save" />)
    const slug = field('admin.field.slug')
    expect(slug).toBeDisabled()
    expect(slug).toHaveValue('guide')
    expect(field('admin.field.priceTon')).toHaveValue('1.5')
    expect(usdtField()).toHaveValue('12.34')
    expect(field('admin.field.deliverInChat')).toBeChecked()
    expect(field('admin.field.sortOrder')).toHaveValue(3)

    await submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    const patch = onSubmit.mock.calls[0]?.[0]
    expect(patch).not.toHaveProperty('slug')
    expect(patch).toEqual(
      expect.objectContaining({ priceTonNano: '1500000000', priceUsdtUnits: USDT_12_34 }),
    )
  })

  it('maps a taken slug reported by the API to the slug field', async () => {
    onSubmit.mockRejectedValue(new ApiError(409, 'slug_taken', 'taken'))
    render(<ProductForm onSubmit={onSubmit} submitLabel="Save" />)
    await fillRequired()
    await userEvent.type(field('admin.field.priceTon'), '1')
    await submit()
    expect(await screen.findByText(t(locale, 'admin.slugTaken'))).toBeInTheDocument()
  })
})
