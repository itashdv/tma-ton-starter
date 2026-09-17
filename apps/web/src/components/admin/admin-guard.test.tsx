import type { MeResponse } from '@tma/shared'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as MeContext from '@/app/me-context'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { AdminGuard } from './admin-guard'

const state = vi.hoisted(() => ({
  me: null as MeResponse | null,
  failed: false,
  pathname: '/admin',
}))

// Only useMe is replaced; the real useLocale keeps resolving the configured default locale.
vi.mock('@/app/me-context', async (importOriginal) => {
  const actual = await importOriginal<typeof MeContext>()
  return { ...actual, useMe: () => ({ me: state.me, failed: state.failed, refresh: () => {} }) }
})
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname }))

const locale = shopConfig.defaultLocale

function profile(isAdmin: boolean): MeResponse {
  return { isAdmin, user: { languageCode: locale } } as unknown as MeResponse
}

function renderGuard() {
  return render(
    <AdminGuard>
      <p>secret</p>
    </AdminGuard>,
  )
}

beforeEach(() => {
  state.me = null
  state.failed = false
  state.pathname = '/admin'
})

describe('AdminGuard', () => {
  it('shows a loader until the profile arrives', () => {
    renderGuard()
    expect(screen.getByText(t(locale, 'admin.loading'))).toBeInTheDocument()
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  it('refuses a non-admin without rendering the children or the tabs', () => {
    state.me = profile(false)
    renderGuard()
    expect(screen.getByText(t(locale, 'admin.noAccess'))).toBeInTheDocument()
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('reports a failed profile call', () => {
    state.failed = true
    renderGuard()
    expect(screen.getByRole('alert')).toHaveTextContent(t(locale, 'admin.profileFailed'))
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  it('renders the tabs and the children for an admin, marking the current section', () => {
    state.me = profile(true)
    state.pathname = '/admin/orders/0123456789abcdef'
    renderGuard()
    expect(screen.getByText('secret')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: t(locale, 'admin.nav') })
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
    expect(hrefs).toEqual(['/admin', '/admin/products', '/admin/orders', '/admin/payments'])
    expect(within(nav).getByRole('link', { name: t(locale, 'admin.tab.orders') })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      within(nav).getByRole('link', { name: t(locale, 'admin.tab.health') }),
    ).not.toHaveAttribute('aria-current')
  })
})
