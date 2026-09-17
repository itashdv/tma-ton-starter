import Link from 'next/link'

import { AdminLink } from '@/components/admin-link'
import { ProductList } from '@/components/product-list'
import { WriteAccessHint } from '@/components/write-access-hint'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

export default function HomePage() {
  const locale = shopConfig.defaultLocale
  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{shopConfig.name}</h1>
        {shopConfig.description ? (
          <p className="text-muted-foreground">{shopConfig.description}</p>
        ) : null}
        <p className="text-sm text-primary">{t(locale, 'shop.tagline')}</p>
      </header>
      <WriteAccessHint />
      <section aria-labelledby="catalog-title" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 id="catalog-title" className="text-lg font-medium">
            {t(locale, 'catalog.title')}
          </h2>
          <div className="flex items-baseline gap-3">
            <AdminLink />
            <Link href="/orders" className="text-sm text-primary underline">
              {t(locale, 'orders.title')}
            </Link>
          </div>
        </div>
        <ProductList />
      </section>
    </main>
  )
}
