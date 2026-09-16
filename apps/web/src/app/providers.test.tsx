import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useRawInitDataValue } from '@/app/init-data-context'
import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import { Providers } from './providers'

const state = vi.hoisted(() => ({
  isInsideTelegram: vi.fn(() => true),
  initTelegram: vi.fn(() => vi.fn()),
  readRawInitData: vi.fn<() => { raw: string | undefined; outsideTelegram: boolean }>(() => ({
    raw: 'user=%7B%7D&hash=abc',
    outsideTelegram: false,
  })),
}))

vi.mock('@/lib/telegram', () => ({
  isInsideTelegram: state.isInsideTelegram,
  initTelegram: state.initTelegram,
  readRawInitData: state.readRawInitData,
  readStartParam: () => undefined,
}))

// The provider only needs to render its children in this test.
vi.mock('@tonconnect/ui-react', () => ({
  TonConnectUIProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
}))

function Probe() {
  const raw = useRawInitDataValue()
  return <span data-testid="raw">{raw ?? 'none'}</span>
}

const locale = shopConfig.defaultLocale

beforeEach(() => {
  state.isInsideTelegram.mockClear().mockReturnValue(true)
  state.initTelegram.mockClear().mockReturnValue(vi.fn())
  state.readRawInitData.mockClear().mockReturnValue({
    raw: 'user=%7B%7D&hash=abc',
    outsideTelegram: false,
  })
})

describe('Providers', () => {
  it('passes the launch init data to the tree', async () => {
    render(
      <Providers>
        <Probe />
      </Providers>,
    )
    await waitFor(() => expect(screen.getByTestId('raw').textContent).toBe('user=%7B%7D&hash=abc'))
    expect(state.initTelegram).toHaveBeenCalledOnce()
  })

  it('shows the "open from Telegram" screen instead of the shop when there is no launch', async () => {
    state.isInsideTelegram.mockReturnValue(false)
    state.readRawInitData.mockReturnValue({ raw: undefined, outsideTelegram: true })
    render(
      <Providers>
        <Probe />
      </Providers>,
    )
    await waitFor(() =>
      expect(screen.getByText(t(locale, 'error.openInTelegram'))).toBeInTheDocument(),
    )
    // Rendering the shop with no credential would only produce failing requests.
    expect(screen.queryByTestId('raw')).not.toBeInTheDocument()
    expect(state.initTelegram).not.toHaveBeenCalled()
  })

  it('treats a launch without init data as "outside Telegram" too', async () => {
    state.readRawInitData.mockReturnValue({ raw: undefined, outsideTelegram: false })
    render(
      <Providers>
        <Probe />
      </Providers>,
    )
    await waitFor(() =>
      expect(screen.getByText(t(locale, 'error.openInTelegram'))).toBeInTheDocument(),
    )
  })

  it('shows the fallback instead of a blank page when the tree throws', async () => {
    function Explode(): never {
      throw new Error('old Telegram client')
    }
    const onError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <Providers>
        <Explode />
      </Providers>,
    )
    await waitFor(() =>
      expect(screen.getByText(t(locale, 'error.openInTelegram'))).toBeInTheDocument(),
    )
    onError.mockRestore()
  })

  it('runs the SDK cleanup on unmount', async () => {
    const cleanup = vi.fn()
    state.initTelegram.mockReturnValue(cleanup)
    const { unmount } = render(
      <Providers>
        <Probe />
      </Providers>,
    )
    await waitFor(() => expect(state.initTelegram).toHaveBeenCalled())
    unmount()
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
