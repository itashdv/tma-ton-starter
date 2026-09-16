import type { MeResponse } from '@tma/shared'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { shopConfig } from '@/lib/shop-config'

import { MeProvider, useLocale, useMe } from './me-context'

const state = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/use-api', () => {
  const api = { get: state.get, post: vi.fn() }
  return { useApi: () => api }
})

function Probe() {
  const locale = useLocale()
  const { me, failed } = useMe()
  return (
    <>
      <span data-testid="locale">{locale}</span>
      <span data-testid="calls">{me ? 'loaded' : failed ? 'failed' : 'pending'}</span>
    </>
  )
}

function meWith(languageCode: string | null): MeResponse {
  return { user: { languageCode } } as MeResponse
}

beforeEach(() => {
  state.get.mockReset()
})

describe('MeProvider', () => {
  it('fetches the profile once for the whole tree', async () => {
    state.get.mockResolvedValue(meWith('ru'))
    render(
      <MeProvider>
        <Probe />
        <Probe />
      </MeProvider>,
    )
    await waitFor(() => expect(screen.getAllByTestId('calls')[0]?.textContent).toBe('loaded'))
    expect(state.get).toHaveBeenCalledTimes(1)
    expect(state.get).toHaveBeenCalledWith('/me')
  })

  it('reports a failure without blocking the tree', async () => {
    state.get.mockRejectedValue(new Error('offline'))
    render(
      <MeProvider>
        <Probe />
      </MeProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('calls').textContent).toBe('failed'))
    expect(screen.getByTestId('locale').textContent).toBe(shopConfig.defaultLocale)
  })
})

describe('useLocale', () => {
  it('uses the language of the Telegram user when the shop speaks it', async () => {
    const other = shopConfig.locales.find((locale) => locale !== shopConfig.defaultLocale)
    expect(other).toBeDefined()
    state.get.mockResolvedValue(meWith(other ?? 'en'))
    render(
      <MeProvider>
        <Probe />
      </MeProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('locale').textContent).toBe(other))
  })

  it('falls back to the configured default for an unsupported or missing language', async () => {
    state.get.mockResolvedValue(meWith('de'))
    const { unmount } = render(
      <MeProvider>
        <Probe />
      </MeProvider>,
    )
    await waitFor(() => expect(state.get).toHaveBeenCalled())
    expect(screen.getByTestId('locale').textContent).toBe(shopConfig.defaultLocale)
    unmount()

    state.get.mockResolvedValue(meWith(null))
    render(
      <MeProvider>
        <Probe />
      </MeProvider>,
    )
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('locale').textContent).toBe(shopConfig.defaultLocale)
  })
})
