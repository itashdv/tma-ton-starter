'use client'

import type { ProductDto } from '@tma/shared'

import { formatAmount } from '@/lib/format'
import { shopConfig } from '@/lib/shop-config'

import { PayButton } from './pay-button'

export function ProductCard({ product }: { product: ProductDto }) {
  const currencies = shopConfig.currencies
  const prices = [
    currencies.includes('TON') && product.priceTonNano
      ? ({ currency: 'TON', amount: product.priceTonNano } as const)
      : null,
    currencies.includes('USDT') && product.priceUsdtUnits
      ? ({ currency: 'USDT', amount: product.priceUsdtUnits } as const)
      : null,
  ].filter((price) => price !== null)

  return (
    <article className="flex flex-col gap-3 rounded-xl border p-4">
      <header className="flex flex-col gap-1">
        <h3 className="font-medium">{product.title}</h3>
        {product.description ? (
          <p className="text-sm text-muted-foreground">{product.description}</p>
        ) : null}
      </header>
      <p className="text-sm">{prices.map((p) => formatAmount(p.currency, p.amount)).join(' · ')}</p>
      <div className="flex flex-wrap gap-2">
        {prices.map((price) => (
          <PayButton
            key={price.currency}
            product={product}
            currency={price.currency}
            amount={price.amount}
          />
        ))}
      </div>
    </article>
  )
}
