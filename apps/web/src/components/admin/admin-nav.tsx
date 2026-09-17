'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { useLocale } from '@/app/me-context'
import { t } from '@/lib/i18n'

const TABS = [
  { href: '/admin', key: 'admin.tab.health' },
  { href: '/admin/products', key: 'admin.tab.products' },
  { href: '/admin/orders', key: 'admin.tab.orders' },
  { href: '/admin/payments', key: 'admin.tab.payments' },
] as const

export function AdminNav() {
  const pathname = usePathname()
  const locale = useLocale()
  return (
    <nav
      aria-label={t(locale, 'admin.nav')}
      className="flex gap-1 overflow-x-auto rounded-xl bg-secondary p-1 text-sm"
    >
      {TABS.map((tab) => {
        // The health tab is the section root, so only an exact match counts for it.
        const active = tab.href === '/admin' ? pathname === tab.href : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'rounded-lg bg-background px-3 py-1.5 font-medium whitespace-nowrap shadow-sm'
                : 'rounded-lg px-3 py-1.5 whitespace-nowrap text-muted-foreground'
            }
          >
            {t(locale, tab.key)}
          </Link>
        )
      })}
    </nav>
  )
}
