import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { abortableSleep, runLoop, type LoopSteps } from './main'

const ITERATION = ['scan', 'expire', 'notify']

interface LoggedFailure {
  step: string
  msg: string
  err: { message: string }
}

interface HarnessConfig {
  /** Aborts the loop once this many iterations completed. */
  stopAfter: number
  rescanMinutes?: number
  pollMs?: number
  /** Replaces the default (recording, succeeding) implementation of a step; calls are still recorded. */
  steps?: Partial<LoopSteps>
  /** Runs after every iteration, before the abort check; `clock` is the fake time in ms. */
  onIteration?: (n: number, clock: { time: number }) => void
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

function createHarness(config: HarnessConfig) {
  const calls: string[] = []
  const sleeps: { ms: number; signal: AbortSignal }[] = []
  const lines: string[] = []
  const controller = new AbortController()
  const clock = { time: Date.parse('2026-09-16T00:00:00Z') }
  // A real pino instance writing JSON to memory, so the test sees exactly what an operator would.
  const log = pino({ level: 'error' }, { write: (line: string) => void lines.push(line) })

  // Records the call and only then delegates, so a synchronous throw still reaches runLoop.
  const step =
    (name: keyof LoopSteps): (() => Promise<void>) =>
    () => {
      calls.push(name)
      const impl = config.steps?.[name]
      return impl ? impl() : Promise.resolve()
    }

  const run = () =>
    runLoop({
      steps: {
        scan: step('scan'),
        expire: step('expire'),
        notify: step('notify'),
        rescan: step('rescan'),
      },
      pollMs: config.pollMs ?? 5_000,
      rescanMinutes: config.rescanMinutes ?? 0,
      now: () => new Date(clock.time),
      sleep:
        config.sleep ??
        (async (ms, signal) => {
          sleeps.push({ ms, signal })
        }),
      log,
      signal: controller.signal,
      onIteration: (n) => {
        config.onIteration?.(n, clock)
        if (n >= config.stopAfter) controller.abort()
      },
    })

  const logged = () => lines.map((line) => JSON.parse(line) as LoggedFailure)
  return { calls, sleeps, controller, clock, run, logged }
}

function repeat(iterations: number): string[] {
  return Array.from({ length: iterations }, () => ITERATION).flat()
}

describe('runLoop', () => {
  it('runs scan, expire and notify in that order on every iteration', async () => {
    const h = createHarness({ stopAfter: 3 })
    await h.run()
    expect(h.calls).toEqual(repeat(3))
  })

  it('sleeps for pollMs with the loop signal after each iteration', async () => {
    const h = createHarness({ stopAfter: 2, pollMs: 1234 })
    await h.run()
    expect(h.sleeps).toHaveLength(2)
    for (const sleep of h.sleeps) {
      expect(sleep.ms).toBe(1234)
      expect(sleep.signal).toBe(h.controller.signal)
    }
  })

  it('does not rescan while the clock has not advanced by rescanMinutes', async () => {
    const h = createHarness({ stopAfter: 5, rescanMinutes: 10 })
    await h.run()
    expect(h.calls).toEqual(repeat(5))
  })

  it('rescans once the interval elapsed and again after the next interval', async () => {
    const h = createHarness({
      stopAfter: 7,
      rescanMinutes: 10,
      onIteration: (_n, clock) => {
        clock.time += 4 * 60_000
      },
    })
    await h.run()
    // Clock at the start of each iteration: 0, 4, 8, 12, 16, 20, 24 minutes. The first re-scan
    // is due at >= 10 (iteration 4, t = 12), the second at >= 22 (iteration 7, t = 24).
    expect(h.calls).toEqual([...repeat(4), 'rescan', ...repeat(3), 'rescan'])
  })

  it('never rescans when rescanMinutes is 0', async () => {
    const h = createHarness({
      stopAfter: 4,
      rescanMinutes: 0,
      onIteration: (_n, clock) => {
        clock.time += 24 * 60 * 60_000
      },
    })
    await h.run()
    expect(h.calls).toEqual(repeat(4))
  })

  it('logs a rejected scan, still runs expire and notify, and keeps looping', async () => {
    let scans = 0
    const h = createHarness({
      stopAfter: 2,
      steps: {
        scan: () => {
          scans += 1
          return scans === 1 ? Promise.reject(new Error('toncenter down')) : Promise.resolve()
        },
      },
    })
    await expect(h.run()).resolves.toBeUndefined()
    expect(h.calls).toEqual(repeat(2))
    expect(h.logged()).toHaveLength(1)
    expect(h.logged()[0]).toMatchObject({
      step: 'scan',
      msg: 'worker step failed',
      err: { message: 'toncenter down' },
    })
  })

  it('treats a synchronous throw inside a step like a rejection', async () => {
    const h = createHarness({
      stopAfter: 2,
      steps: {
        notify: () => {
          throw new Error('sync boom')
        },
      },
    })
    await expect(h.run()).resolves.toBeUndefined()
    expect(h.calls).toEqual(repeat(2))
    expect(h.logged().map((entry) => [entry.step, entry.err.message])).toEqual([
      ['notify', 'sync boom'],
      ['notify', 'sync boom'],
    ])
  })

  it('stops after the signal aborts and runs no further steps', async () => {
    const h = createHarness({ stopAfter: 1 })
    await h.run()
    expect(h.calls).toEqual(ITERATION)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.calls).toEqual(ITERATION)
  })

  it('stops between steps when the signal aborts during scan', async () => {
    const h = createHarness({
      stopAfter: 99,
      rescanMinutes: 1,
      steps: {
        scan: async () => {
          h.controller.abort()
        },
      },
    })
    await h.run()
    expect(h.calls).toEqual(['scan'])
    expect(h.sleeps).toEqual([])
  })

  it('skips notify and the due rescan when the signal aborts during expire', async () => {
    const h = createHarness({
      stopAfter: 99,
      rescanMinutes: 1,
      onIteration: (_n, clock) => {
        clock.time += 60_000
      },
      steps: {
        expire: async () => {
          h.controller.abort()
        },
      },
    })
    await h.run()
    expect(h.calls).toEqual(['scan', 'expire'])
  })

  it('returns without running a step when the signal is already aborted', async () => {
    const h = createHarness({ stopAfter: 1 })
    h.controller.abort()
    await h.run()
    expect(h.calls).toEqual([])
    expect(h.sleeps).toEqual([])
  })

  it('does not start another iteration when the abort arrives during sleep', async () => {
    const h = createHarness({
      stopAfter: 99,
      sleep: async () => {
        h.controller.abort()
      },
    })
    await h.run()
    expect(h.calls).toEqual(ITERATION)
  })
})

describe('abortableSleep', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves early on abort and leaves no pending timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const sleeping = abortableSleep(60_000, controller.signal)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await expect(sleeping).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves after the delay when nothing aborts', async () => {
    vi.useFakeTimers()
    let done = false
    void abortableSleep(1_000, new AbortController().signal).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves immediately without a timer for an already aborted signal', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
