import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ isTMA: vi.fn(() => false), mockTelegramEnv: vi.fn() }))

vi.mock('@tma.js/sdk-react', () => ({ isTMA: sdk.isTMA, mockTelegramEnv: sdk.mockTelegramEnv }))

const SIGNED = 'user=%7B%22id%22%3A1%7D&auth_date=1700000000&signature=&hash=abc'

async function loadModule() {
  vi.resetModules()
  await import('./instrumentation-client')
}

beforeEach(() => {
  sdk.isTMA.mockClear().mockReturnValue(false)
  sdk.mockTelegramEnv.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('development environment mock', () => {
  it('never mocks Telegram outside development, even with init data present', async () => {
    for (const nodeEnv of ['production', 'test']) {
      vi.stubEnv('NODE_ENV', nodeEnv)
      vi.stubEnv('NEXT_PUBLIC_TG_MOCK_INIT_DATA', SIGNED)
      await loadModule()
      expect(sdk.mockTelegramEnv, nodeEnv).not.toHaveBeenCalled()
    }
  })

  it('mocks only when development has a signed string and Telegram is absent', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_TG_MOCK_INIT_DATA', '')
    await loadModule()
    expect(sdk.mockTelegramEnv).not.toHaveBeenCalled()

    vi.stubEnv('NEXT_PUBLIC_TG_MOCK_INIT_DATA', SIGNED)
    sdk.isTMA.mockReturnValue(true) // already inside Telegram: nothing to fake
    await loadModule()
    expect(sdk.mockTelegramEnv).not.toHaveBeenCalled()

    sdk.isTMA.mockReturnValue(false)
    await loadModule()
    expect(sdk.mockTelegramEnv).toHaveBeenCalledOnce()
    const options = sdk.mockTelegramEnv.mock.calls[0]?.[0] as {
      launchParams: { tgWebAppData: string; tgWebAppVersion: string; tgWebAppPlatform: string }
    }
    // The SDK schema requires both of these and takes init data as a raw query string.
    expect(options.launchParams.tgWebAppVersion).toBeTruthy()
    expect(options.launchParams.tgWebAppPlatform).toBeTruthy()
    expect(options.launchParams.tgWebAppData).toBe(SIGNED)
  })
})
