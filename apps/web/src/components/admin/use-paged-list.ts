'use client'

import { useCallback, useEffect, useState } from 'react'

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export type FetchPage<T> = (cursor: string | null) => Promise<Page<T>>

export interface PagedList<T> {
  /** null until the first page of the current fetcher has arrived. */
  items: T[] | null
  nextCursor: string | null
  error: unknown
  loadingMore: boolean
  loadMore: () => void
  /** Rewrites rows in place, for example after a successful action on one of them. */
  update: (map: (item: T) => T) => void
}

interface Loaded<T> {
  source: FetchPage<T>
  items: T[]
  nextCursor: string | null
}

interface Failed<T> {
  source: FetchPage<T>
  error: unknown
}

/**
 * Keyset pagination for the admin lists. Loaded rows remember which fetcher produced them, so
 * a new filter (a new `fetchPage`) shows the loader again without resetting state inside the
 * effect; later pages append. `fetchPage` must be memoised by the caller.
 */
export function usePagedList<T>(fetchPage: FetchPage<T>): PagedList<T> {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const [failed, setFailed] = useState<Failed<T> | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let active = true
    fetchPage(null)
      .then((page) => {
        if (!active) return
        setLoaded({ source: fetchPage, items: page.items, nextCursor: page.nextCursor })
        setFailed(null)
      })
      .catch((error: unknown) => {
        if (active) setFailed({ source: fetchPage, error })
      })
    return () => {
      active = false
    }
  }, [fetchPage])

  const current = loaded?.source === fetchPage ? loaded : null
  const error = failed?.source === fetchPage ? failed.error : null

  const loadMore = useCallback(() => {
    const cursor = current?.nextCursor
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    fetchPage(cursor)
      .then((page) => {
        setLoaded((previous) =>
          previous?.source === fetchPage
            ? {
                source: fetchPage,
                items: [...previous.items, ...page.items],
                nextCursor: page.nextCursor,
              }
            : previous,
        )
      })
      .catch((failure: unknown) => setFailed({ source: fetchPage, error: failure }))
      .finally(() => setLoadingMore(false))
  }, [current, fetchPage, loadingMore])

  const update = useCallback((map: (item: T) => T) => {
    setLoaded((previous) => (previous ? { ...previous, items: previous.items.map(map) } : previous))
  }, [])

  return {
    items: current?.items ?? null,
    nextCursor: current?.nextCursor ?? null,
    error,
    loadingMore,
    loadMore,
    update,
  }
}
