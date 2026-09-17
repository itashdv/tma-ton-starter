'use client'

import type { ReactNode } from 'react'

import { useLocale, useMe } from '@/app/me-context'
import { t } from '@/lib/i18n'

import { AdminNav } from './admin-nav'

/**
 * UX only: it keeps the admin screens out of sight for everyone else. Access itself is enforced
 * by the API, which checks the Telegram user of every `/admin/*` request against
 * TELEGRAM_ADMIN_IDS, so a user who bypasses this guard still gets nothing but 403s.
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const { me, failed } = useMe()
  const locale = useLocale()

  if (me === null) {
    return failed ? (
      <p role="alert" className="text-sm text-destructive">
        {t(locale, 'admin.profileFailed')}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">{t(locale, 'admin.loading')}</p>
    )
  }

  if (!me.isAdmin) {
    return (
      <p className="rounded-xl border p-4 text-sm text-muted-foreground">
        {t(locale, 'admin.noAccess')}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <AdminNav />
      {children}
    </div>
  )
}
