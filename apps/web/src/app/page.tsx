import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

export default function HomePage() {
  const locale = shopConfig.defaultLocale
  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{shopConfig.name}</h1>
        {shopConfig.description ? (
          <p className="text-muted-foreground">{shopConfig.description}</p>
        ) : null}
        <p className="text-sm text-primary">{t(locale, 'shop.tagline')}</p>
      </header>
      <section aria-labelledby="catalog-title" className="rounded-xl border p-4">
        <h2 id="catalog-title" className="text-lg font-medium">
          {t(locale, 'catalog.title')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{t(locale, 'catalog.comingSoon')}</p>
      </section>
    </main>
  )
}
