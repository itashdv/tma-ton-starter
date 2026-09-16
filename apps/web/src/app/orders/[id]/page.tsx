import Link from 'next/link'

import { OrderStatus } from '@/components/order-status'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const locale = shopConfig.defaultLocale
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">{t(locale, 'order.title')}</h1>
        <Link href="/orders" className="text-sm text-primary underline">
          {t(locale, 'orders.title')}
        </Link>
      </div>
      <OrderStatus orderId={id} />
    </main>
  )
}
