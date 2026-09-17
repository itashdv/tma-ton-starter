import Link from 'next/link'
import type { ReactNode } from 'react'

import { AdminGuard } from '@/components/admin/admin-guard'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

export default function AdminLayout({ children }: { children: ReactNode }) {
  const locale = shopConfig.defaultLocale
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">{t(locale, 'admin.title')}</h1>
        <Link href="/" className="text-sm text-primary underline">
          {t(locale, 'catalog.title')}
        </Link>
      </div>
      <AdminGuard>{children}</AdminGuard>
    </main>
  )
}
