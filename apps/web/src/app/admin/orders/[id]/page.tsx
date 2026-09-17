import Link from 'next/link'

import { OrderDetails } from '@/components/admin/order-details'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const locale = shopConfig.defaultLocale
  return (
    <div className="flex flex-col gap-3">
      <Link href="/admin/orders" className="self-start text-sm text-primary underline">
        ← {t(locale, 'admin.tab.orders')}
      </Link>
      <OrderDetails orderId={id} />
    </div>
  )
}
