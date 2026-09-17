'use client'

import { useLocale } from '@/app/me-context'
import { adminErrorMessage } from '@/lib/admin-errors'
import { t } from '@/lib/i18n'

import type { PagedList } from './use-paged-list'

/** Loader, error, empty state and the "load more" button shared by the paginated lists. */
export function ListFooter<T>({ list }: { list: PagedList<T> }) {
  const locale = useLocale()
  return (
    <>
      {list.items === null && list.error === null ? (
        <p className="text-sm text-muted-foreground">{t(locale, 'admin.loadingData')}</p>
      ) : null}
      {list.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {adminErrorMessage(list.error, locale, 'admin.loadFailed')}
        </p>
      ) : null}
      {list.items?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, 'admin.empty')}</p>
      ) : null}
      {list.nextCursor ? (
        <button
          type="button"
          disabled={list.loadingMore}
          onClick={list.loadMore}
          className="rounded-lg border px-4 py-2 text-sm disabled:opacity-60"
        >
          {list.loadingMore ? t(locale, 'admin.loadingData') : t(locale, 'admin.loadMore')}
        </button>
      ) : null}
    </>
  )
}
