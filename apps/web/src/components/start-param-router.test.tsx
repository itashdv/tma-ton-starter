import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StartParamRouter } from './start-param-router'

const state = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: '/',
  readStartParam: vi.fn<() => string | undefined>(() => undefined),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: state.replace, push: vi.fn() }),
  usePathname: () => state.pathname,
}))
vi.mock('@/lib/telegram', () => ({ readStartParam: state.readStartParam }))

beforeEach(() => {
  state.replace.mockClear()
  state.pathname = '/'
  state.readStartParam.mockReset().mockReturnValue(undefined)
})

describe('StartParamRouter', () => {
  it('opens the order a notification link points at', async () => {
    state.readStartParam.mockReturnValue('order_0123456789abcdef')
    render(<StartParamRouter />)
    await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/orders/0123456789abcdef'))
  })

  it('ignores a launch without a start parameter or with an unknown one', async () => {
    render(<StartParamRouter />)
    await waitFor(() => expect(state.readStartParam).toHaveBeenCalled())
    expect(state.replace).not.toHaveBeenCalled()

    // A crafted value must not steer the app anywhere.
    state.readStartParam.mockReturnValue('admin')
    render(<StartParamRouter />)
    await waitFor(() => expect(state.readStartParam).toHaveBeenCalledTimes(2))
    expect(state.replace).not.toHaveBeenCalled()
  })

  it('does not hijack navigation once the user is on another page', async () => {
    state.readStartParam.mockReturnValue('order_0123456789abcdef')
    state.pathname = '/orders'
    render(<StartParamRouter />)
    await waitFor(() => expect(state.readStartParam).toHaveBeenCalled())
    expect(state.replace).not.toHaveBeenCalled()
  })
})
