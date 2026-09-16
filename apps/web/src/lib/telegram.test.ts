import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  init: vi.fn(() => vi.fn()),
  restore: vi.fn(),
  isTMA: vi.fn(() => true),
  ready: vi.fn(),
  expand: vi.fn(),
  retrieveRawInitData: vi.fn<() => string | undefined>(() => 'user=%7B%7D&hash=abc'),
  requestWriteAccess: vi.fn(async () => 'allowed'),
  isAvailable: vi.fn(() => true),
}))

class FakeLaunchParamsRetrieveError extends Error {
  static is(value: unknown): boolean {
    return value instanceof FakeLaunchParamsRetrieveError
  }
}

vi.mock('@tma.js/sdk-react', () => ({
  LaunchParamsRetrieveError: FakeLaunchParamsRetrieveError,
  init: sdk.init,
  initData: { restore: sdk.restore },
  isTMA: sdk.isTMA,
  miniApp: { ready: { ifAvailable: sdk.ready } },
  viewport: { expand: { ifAvailable: sdk.expand } },
  retrieveRawInitData: sdk.retrieveRawInitData,
  requestWriteAccess: Object.assign(sdk.requestWriteAccess, { isAvailable: sdk.isAvailable }),
}))

const { askWriteAccess, canRequestWriteAccess, initTelegram, isInsideTelegram, readRawInitData } =
  await import('./telegram')

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockClear()
  sdk.isTMA.mockReturnValue(true)
  sdk.isAvailable.mockReturnValue(true)
  sdk.requestWriteAccess.mockResolvedValue('allowed')
  sdk.retrieveRawInitData.mockReturnValue('user=%7B%7D&hash=abc')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isInsideTelegram', () => {
  it('reports false instead of throwing when the SDK cannot tell', () => {
    sdk.isTMA.mockImplementation(() => {
      throw new Error('no launch params')
    })
    expect(isInsideTelegram()).toBe(false)
  })
})

describe('initTelegram', () => {
  it('initialises, restores init data and returns the cleanup', () => {
    const cleanup = vi.fn()
    sdk.init.mockReturnValue(cleanup)
    const returned = initTelegram()
    expect(sdk.init).toHaveBeenCalledOnce()
    // init() does not restore init data by itself.
    expect(sdk.restore).toHaveBeenCalledOnce()
    expect(sdk.ready).toHaveBeenCalledOnce()
    expect(sdk.expand).toHaveBeenCalledOnce()
    expect(returned).toBe(cleanup)
  })

  it('survives a missing launch context but rethrows anything else', () => {
    sdk.restore.mockImplementation(() => {
      throw new FakeLaunchParamsRetrieveError('nothing to restore')
    })
    expect(() => initTelegram()).not.toThrow()

    sdk.restore.mockImplementation(() => {
      throw new TypeError('broken SDK')
    })
    expect(() => initTelegram()).toThrow(TypeError)
  })
})

describe('readRawInitData', () => {
  it('returns the raw string as the SDK produced it', () => {
    expect(readRawInitData()).toEqual({ raw: 'user=%7B%7D&hash=abc', outsideTelegram: false })
  })

  it('distinguishes "no launch params" from "launch without init data"', () => {
    sdk.retrieveRawInitData.mockImplementation(() => {
      throw new FakeLaunchParamsRetrieveError('outside')
    })
    expect(readRawInitData()).toEqual({ raw: undefined, outsideTelegram: true })

    sdk.retrieveRawInitData.mockReturnValue(undefined)
    expect(readRawInitData()).toEqual({ raw: undefined, outsideTelegram: false })
  })
})

describe('write access', () => {
  it('maps the granted status to true and anything else to false', async () => {
    await expect(askWriteAccess()).resolves.toBe(true)
    sdk.requestWriteAccess.mockResolvedValue('cancelled')
    await expect(askWriteAccess()).resolves.toBe(false)
  })

  it('does not call the popup when the client does not support it', async () => {
    sdk.isAvailable.mockReturnValue(false)
    expect(canRequestWriteAccess()).toBe(false)
    await expect(askWriteAccess()).resolves.toBe(false)
    expect(sdk.requestWriteAccess).not.toHaveBeenCalled()
  })

  it('treats a throwing availability check as unsupported', () => {
    sdk.isAvailable.mockImplementation(() => {
      throw new Error('not initialised')
    })
    expect(canRequestWriteAccess()).toBe(false)
  })
})
