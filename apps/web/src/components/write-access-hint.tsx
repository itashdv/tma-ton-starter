'use client'

import { useState } from 'react'

import { useLocale, useMe } from '@/app/me-context'
import { t } from '@/lib/i18n'
import { askWriteAccess, canRequestWriteAccess } from '@/lib/telegram'

/**
 * A bot cannot message a user who never allowed it, so the receipt would silently fail. The
 * order page always shows the purchase; this hint only offers the chat as a second channel.
 */
export function WriteAccessHint() {
  const { me, refresh } = useMe()
  const locale = useLocale()
  const [granted, setGranted] = useState(false)

  const allowed = granted || me?.user.allowsWriteToPm !== false
  if (allowed || !canRequestWriteAccess()) return null

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <span>{t(locale, 'checkout.allowWrite')}</span>
      <button
        type="button"
        className="rounded-md border px-3 py-1"
        onClick={() => {
          void askWriteAccess().then((ok) => {
            if (!ok) return
            setGranted(true)
            // The flag lives in init data, so refresh the profile for the rest of the app.
            refresh()
          })
        }}
      >
        {t(locale, 'checkout.allow')}
      </button>
    </div>
  )
}
