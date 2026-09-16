import type { MeResponse } from '@tma/shared'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MeProvider } from '@/app/me-context'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { WriteAccessHint } from './write-access-hint'

const state = vi.hoisted(() => ({
  get: vi.fn(),
  askWriteAccess: vi.fn(async () => true),
  canRequestWriteAccess: vi.fn(() => true),
}))

// The real useApi memoises the client; a new object per render would restart the effect.
vi.mock('@/lib/use-api', () => {
  const api = { get: state.get, post: vi.fn() }
  return { useApi: () => api }
})
vi.mock('@/lib/telegram', () => ({
  askWriteAccess: state.askWriteAccess,
  canRequestWriteAccess: state.canRequestWriteAccess,
}))

const locale = shopConfig.defaultLocale

function me(allowsWriteToPm: boolean): Partial<MeResponse> {
  return { user: { allowsWriteToPm, languageCode: locale } as MeResponse['user'] }
}

function renderHint() {
  return render(
    <MeProvider>
      <WriteAccessHint />
    </MeProvider>,
  )
}

beforeEach(() => {
  state.get.mockReset()
  state.askWriteAccess.mockClear().mockResolvedValue(true)
  state.canRequestWriteAccess.mockClear().mockReturnValue(true)
})

describe('WriteAccessHint', () => {
  it('is invisible when the bot may already message the user', async () => {
    state.get.mockResolvedValue(me(true))
    renderHint()
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/me'))
    expect(screen.queryByText(t(locale, 'checkout.allowWrite'))).not.toBeInTheDocument()
  })

  it('offers the permission and disappears once granted', async () => {
    state.get.mockResolvedValue(me(false))
    renderHint()
    await waitFor(() =>
      expect(screen.getByText(t(locale, 'checkout.allowWrite'))).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByRole('button', { name: t(locale, 'checkout.allow') }))
    await waitFor(() =>
      expect(screen.queryByText(t(locale, 'checkout.allowWrite'))).not.toBeInTheDocument(),
    )
    expect(state.askWriteAccess).toHaveBeenCalledOnce()
    // The flag lives in init data, so the profile is refetched for the rest of the app.
    await waitFor(() => expect(state.get.mock.calls.length).toBeGreaterThan(1))
  })

  it('keeps the hint when the user refuses', async () => {
    state.get.mockResolvedValue(me(false))
    state.askWriteAccess.mockResolvedValue(false)
    renderHint()
    await waitFor(() =>
      expect(screen.getByText(t(locale, 'checkout.allowWrite'))).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByRole('button', { name: t(locale, 'checkout.allow') }))

    // Wait for the refusal to be processed first: a plain waitFor would pass on its very first
    // check, before any state update could have hidden the hint.
    await waitFor(() => expect(state.askWriteAccess).toHaveBeenCalledOnce())
    await act(async () => {})
    expect(screen.getByText(t(locale, 'checkout.allowWrite'))).toBeInTheDocument()
  })

  it('never blocks the shop when the profile call fails or the popup is unsupported', async () => {
    state.get.mockRejectedValue(new Error('offline'))
    const { unmount } = renderHint()
    await waitFor(() => expect(state.get).toHaveBeenCalled())
    expect(screen.queryByText(t(locale, 'checkout.allowWrite'))).not.toBeInTheDocument()
    unmount()

    state.get.mockResolvedValue(me(false))
    state.canRequestWriteAccess.mockReturnValue(false)
    renderHint()
    await waitFor(() => expect(state.get.mock.calls.length).toBeGreaterThan(1))
    expect(screen.queryByText(t(locale, 'checkout.allowWrite'))).not.toBeInTheDocument()
  })
})
