'use client'

import type { ProductDto } from '@tma/shared'
import { useEffect, useState } from 'react'

import { useLocale } from '@/app/me-context'
import { errorMessage } from '@/lib/errors'
import { t } from '@/lib/i18n'
import { useApi } from '@/lib/use-api'

import { ProductCard } from './product-card'

export function ProductList() {
  const api = useApi()
  const locale = useLocale()
  const [products, setProducts] = useState<ProductDto[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api
      .get<{ products: ProductDto[] }>('/products', { auth: false })
      .then((data) => {
        if (active) setProducts(data.products)
      })
      .catch((error: unknown) => {
        if (active) setFailure(errorMessage(error, locale, { fallbackKey: 'catalog.failed' }))
      })
    return () => {
      active = false
    }
  }, [api, locale])

  if (failure) {
    return <p className="text-sm text-destructive">{failure}</p>
  }
  if (products === null) {
    return <p className="text-sm text-muted-foreground">{t(locale, 'catalog.loading')}</p>
  }
  if (products.length === 0) {
    return <p className="text-sm text-muted-foreground">{t(locale, 'catalog.empty')}</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  )
}
