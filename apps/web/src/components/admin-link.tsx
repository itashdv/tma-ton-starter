'use client'

import Link from 'next/link'

import { useLocale, useMe } from '@/app/me-context'
import { t } from '@/lib/i18n'

/** Entry point to the admin area; the API, not this flag, decides who may use it. */
export function AdminLink() {
  const { me } = useMe()
  const locale = useLocale()
  if (me?.isAdmin !== true) return null
  return (
    <Link href="/admin" className="text-sm text-primary underline">
      {t(locale, 'admin.title')}
    </Link>
  )
}
