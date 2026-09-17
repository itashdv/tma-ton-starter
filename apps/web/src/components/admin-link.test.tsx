import type { MeResponse } from '@tma/shared'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as MeContext from '@/app/me-context'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { AdminLink } from './admin-link'

const state = vi.hoisted(() => ({ me: null as MeResponse | null }))

vi.mock('@/app/me-context', async (importOriginal) => {
  const actual = await importOriginal<typeof MeContext>()
  return { ...actual, useMe: () => ({ me: state.me, failed: false, refresh: () => {} }) }
})

const locale = shopConfig.defaultLocale

function profile(isAdmin: boolean): MeResponse {
  return { isAdmin, user: { languageCode: locale } } as unknown as MeResponse
}

beforeEach(() => {
  state.me = null
})

describe('AdminLink', () => {
  it('stays hidden while the profile is unknown or the user is not an admin', () => {
    const { unmount } = render(<AdminLink />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    unmount()

    state.me = profile(false)
    render(<AdminLink />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('links administrators to the admin area', () => {
    state.me = profile(true)
    render(<AdminLink />)
    expect(screen.getByRole('link', { name: t(locale, 'admin.title') })).toHaveAttribute(
      'href',
      '/admin',
    )
  })
})
