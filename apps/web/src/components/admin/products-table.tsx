'use client'

import type { AdminProductDto, AdminProductInput, AdminProductPatch } from '@tma/shared'
import { useCallback, useEffect, useState } from 'react'

import { useLocale } from '@/app/me-context'
import { createProduct, listProducts, updateProduct } from '@/lib/admin-api'
import { adminErrorMessage } from '@/lib/admin-errors'
import { formatAmount } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useApi } from '@/lib/use-api'

import { Badge } from './badge'
import { ProductForm } from './product-form'

const PAYLOAD_PREVIEW = 48
const BUTTON = 'rounded-lg border px-3 py-1.5 text-sm'

function isCreateInput(input: AdminProductInput | AdminProductPatch): input is AdminProductInput {
  return typeof input.slug === 'string' && typeof input.title === 'string'
}

/** Payloads are secrets (keys, links); the list only hints at them. */
function preview(payload: string): string {
  return payload.length > PAYLOAD_PREVIEW ? `${payload.slice(0, PAYLOAD_PREVIEW)}…` : payload
}

function priceLine(product: AdminProductDto): string {
  return [
    product.priceTonNano ? formatAmount('TON', product.priceTonNano) : null,
    product.priceUsdtUnits ? formatAmount('USDT', product.priceUsdtUnits) : null,
  ]
    .filter((price) => price !== null)
    .join(' · ')
}

export function ProductsTable() {
  const api = useApi()
  const locale = useLocale()
  const [products, setProducts] = useState<AdminProductDto[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    listProducts(api)
      .then((data) => {
        if (!active) return
        setProducts(data.products)
        setError(null)
      })
      .catch((failure: unknown) => {
        if (active) setError(failure)
      })
    return () => {
      active = false
    }
  }, [api, nonce])

  // The API owns the ordering (sortOrder, then title), so every change is followed by a reload.
  const reload = useCallback(() => setNonce((value) => value + 1), [])

  const create = useCallback(
    async (input: AdminProductInput | AdminProductPatch) => {
      if (!isCreateInput(input)) throw new Error('a new product needs a slug and a title')
      await createProduct(api, input)
      setCreating(false)
      reload()
    },
    [api, reload],
  )

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t(locale, 'admin.tab.products')}</h2>
        <button type="button" className={BUTTON} onClick={() => setCreating((open) => !open)}>
          {creating ? t(locale, 'admin.form.cancel') : t(locale, 'admin.products.new')}
        </button>
      </div>
      {creating ? (
        <div className="rounded-xl border p-4">
          <ProductForm submitLabel={t(locale, 'admin.products.create')} onSubmit={create} />
        </div>
      ) : null}
      {products === null && error === null ? (
        <p className="text-sm text-muted-foreground">{t(locale, 'admin.loadingData')}</p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {adminErrorMessage(error, locale, 'admin.loadFailed')}
        </p>
      ) : null}
      {products?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, 'admin.empty')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {(products ?? []).map((product) => {
          const editing = editingId === product.id
          return (
            <li
              key={product.id}
              className={
                product.isActive
                  ? 'flex flex-col gap-2 rounded-xl border p-4'
                  : 'flex flex-col gap-2 rounded-xl border border-dashed p-4 opacity-70'
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{product.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">{product.slug}</span>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {product.isActive ? null : (
                    <Badge tone="danger">{t(locale, 'admin.products.inactive')}</Badge>
                  )}
                  {product.deliverInChat ? (
                    <Badge>{t(locale, 'admin.products.inChat')}</Badge>
                  ) : null}
                </div>
              </div>
              <p className="text-sm">{priceLine(product)}</p>
              <p className="text-xs text-muted-foreground">
                {t(locale, 'admin.field.sortOrder')}: {product.sortOrder}
              </p>
              {product.deliveryPayload ? (
                <p className="rounded-lg bg-secondary p-2 font-mono text-xs break-all">
                  {preview(product.deliveryPayload)}
                </p>
              ) : null}
              <button
                type="button"
                className={`${BUTTON} self-start`}
                onClick={() => setEditingId(editing ? null : product.id)}
              >
                {editing ? t(locale, 'admin.form.cancel') : t(locale, 'admin.products.edit')}
              </button>
              {editing ? (
                <ProductForm
                  initial={product}
                  submitLabel={t(locale, 'admin.products.save')}
                  onSubmit={async (patch) => {
                    await updateProduct(api, product.id, patch)
                    setEditingId(null)
                    reload()
                  }}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
