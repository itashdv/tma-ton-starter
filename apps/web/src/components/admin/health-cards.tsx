'use client'

import type { AdminHealthDto } from '@tma/shared'
import { useEffect, useState } from 'react'

import { useLocale } from '@/app/me-context'
import { getAdminHealth } from '@/lib/admin-api'
import { adminErrorMessage } from '@/lib/admin-errors'
import { formatDateTime } from '@/lib/format'
import { t } from '@/lib/i18n'
import { shorten } from '@/lib/shorten'
import { useApi } from '@/lib/use-api'

import { Badge } from './badge'
import { DetailRow } from './detail-row'

const COUNT_KEYS = [
  'unmatchedPayments',
  'underpaidPayments',
  'ignoredPayments',
  'failedNotifications',
  'pendingNotifications',
  'pendingOrders',
  'paidOrders',
] as const satisfies readonly (keyof AdminHealthDto['counts'])[]

function ExplorerLink({ href, address }: { href: string; address: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-mono text-primary underline">
      {shorten(address, 6)}
    </a>
  )
}

function StaleBadge({ stale }: { stale: boolean }) {
  const locale = useLocale()
  return (
    <Badge tone={stale ? 'danger' : 'ok'}>
      {t(locale, stale ? 'admin.health.stale' : 'admin.health.ok')}
    </Badge>
  )
}

export function HealthCards() {
  const api = useApi()
  const locale = useLocale()
  const [health, setHealth] = useState<AdminHealthDto | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    getAdminHealth(api)
      .then((data) => {
        if (!active) return
        setHealth(data)
        setError(null)
      })
      .catch((failure: unknown) => {
        if (active) setError(failure)
      })
    return () => {
      active = false
    }
  }, [api, nonce])

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t(locale, 'admin.tab.health')}</h2>
        <button
          type="button"
          className="rounded-lg border px-3 py-1.5 text-sm"
          onClick={() => setNonce((value) => value + 1)}
        >
          {t(locale, 'admin.refresh')}
        </button>
      </div>
      {health === null && error === null ? (
        <p className="text-sm text-muted-foreground">{t(locale, 'admin.loadingData')}</p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {adminErrorMessage(error, locale, 'admin.loadFailed')}
        </p>
      ) : null}
      {health ? (
        <>
          <article className="flex flex-col gap-2 rounded-xl border p-4">
            <header className="flex items-center justify-between gap-2">
              <h3 className="font-medium">{t(locale, 'admin.health.worker')}</h3>
              <StaleBadge stale={health.worker.stale} />
            </header>
            <dl className="flex flex-col gap-1 text-sm">
              <DetailRow label={t(locale, 'admin.health.lastPoll')}>
                {health.worker.lastPollAt
                  ? `${formatDateTime(health.worker.lastPollAt, locale)} · ${t(locale, 'admin.health.age', { seconds: health.worker.ageSec ?? 0 })}`
                  : t(locale, 'admin.health.never')}
              </DetailRow>
              <DetailRow label={t(locale, 'admin.health.network')}>{health.network}</DetailRow>
            </dl>
            <p className="text-xs text-muted-foreground">
              {t(locale, 'admin.health.pollEvery', { seconds: Math.round(health.pollMs / 1000) })}
            </p>
          </article>

          <h3 className="font-medium">{t(locale, 'admin.health.cursors')}</h3>
          {health.cursors.map((cursor) => (
            <article key={cursor.account} className="flex flex-col gap-2 rounded-xl border p-4">
              <header className="flex items-center justify-between gap-2">
                <h4 className="font-medium">{t(locale, `admin.health.cursor.${cursor.label}`)}</h4>
                <StaleBadge stale={cursor.stale} />
              </header>
              <dl className="flex flex-col gap-1 text-sm">
                <DetailRow label={t(locale, 'admin.health.address')}>
                  <ExplorerLink href={cursor.url} address={cursor.address} />
                </DetailRow>
                <DetailRow label={t(locale, 'admin.health.lag')}>
                  {cursor.lagSeconds === null
                    ? t(locale, 'admin.health.never')
                    : t(locale, 'admin.health.seconds', { seconds: cursor.lagSeconds })}
                </DetailRow>
                <DetailRow label={t(locale, 'admin.health.lastLt')}>
                  <span className="font-mono">{cursor.lastLt}</span>
                </DetailRow>
              </dl>
              {cursor.lastError ? (
                <p className="text-xs text-destructive break-all">
                  {t(locale, 'admin.health.lastError')}: {cursor.lastError}
                </p>
              ) : null}
            </article>
          ))}

          <h3 className="font-medium">{t(locale, 'admin.health.counts')}</h3>
          <div className="grid grid-cols-2 gap-2">
            {COUNT_KEYS.map((key) => (
              <div key={key} className="flex flex-col gap-1 rounded-xl border p-3">
                <span className="text-2xl font-semibold">{health.counts[key]}</span>
                <span className="text-xs text-muted-foreground">
                  {t(locale, `admin.health.count.${key}`)}
                </span>
              </div>
            ))}
          </div>

          <article className="rounded-xl border p-4">
            <dl className="flex flex-col gap-1 text-sm">
              <DetailRow label={t(locale, 'admin.health.merchant')}>
                <ExplorerLink href={health.merchant.url} address={health.merchant.address} />
              </DetailRow>
              {health.usdtMaster ? (
                <DetailRow label={t(locale, 'admin.health.usdtMaster')}>
                  <ExplorerLink href={health.usdtMaster.url} address={health.usdtMaster.address} />
                </DetailRow>
              ) : null}
            </dl>
          </article>
        </>
      ) : null}
    </section>
  )
}
