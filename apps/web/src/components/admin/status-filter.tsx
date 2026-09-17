'use client'

import { useId } from 'react'

import { useLocale } from '@/app/me-context'
import { t } from '@/lib/i18n'

export interface StatusFilterProps<S extends string> {
  value: S | ''
  options: readonly S[]
  /** i18n key for an option's label. */
  labelKey: (status: S) => string
  onChange: (value: S | '') => void
}

/** "All statuses" plus one option per status; an unknown value falls back to "all". */
export function StatusFilter<S extends string>({
  value,
  options,
  labelKey,
  onChange,
}: StatusFilterProps<S>) {
  const locale = useLocale()
  const id = useId()
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="text-muted-foreground">
        {t(locale, 'admin.filter.status')}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) =>
          onChange(options.find((option) => option === event.target.value) ?? '')
        }
        className="rounded-lg border bg-background px-2 py-1.5 text-sm"
      >
        <option value="">{t(locale, 'admin.filter.all')}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {t(locale, labelKey(option))}
          </option>
        ))}
      </select>
    </div>
  )
}
