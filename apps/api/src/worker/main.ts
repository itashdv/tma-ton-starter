import type pino from 'pino'

export interface LoopSteps {
  scan: () => Promise<void>
  expire: () => Promise<void>
  notify: () => Promise<void>
  /** Safety re-scan without moving cursors; scheduled every `rescanMinutes` (0 = never). */
  rescan: () => Promise<void>
}

export interface RunLoopOptions {
  steps: LoopSteps
  pollMs: number
  rescanMinutes: number
  now: () => Date
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  log: pino.Logger
  signal: AbortSignal
  /** Called after every iteration (tests count iterations); optional. */
  onIteration?: (n: number) => void
}

type StepName = keyof LoopSteps

/**
 * Runs one step and contains its failure. Payment detection must not depend on the notifier
 * or the expirer being healthy, so a failing step is logged and the next one still runs;
 * the loop itself never rejects. `await` inside the try folds a synchronous throw into the
 * same path as a rejected promise.
 */
async function runStep(name: StepName, step: () => Promise<void>, log: pino.Logger) {
  try {
    await step()
  } catch (err) {
    log.error({ err, step: name }, 'worker step failed')
  }
}

/**
 * The worker's main loop: scan → expire → notify every `pollMs`, plus a full re-scan every
 * `rescanMinutes` as a safety net against cursor bugs. Time and sleeping are injected so tests
 * drive the clock instead of waiting; the loop resolves as soon as `signal` aborts.
 */
export async function runLoop(options: RunLoopOptions): Promise<void> {
  const { steps, pollMs, rescanMinutes, now, sleep, log, signal } = options
  const rescanEveryMs = rescanMinutes * 60_000
  // The first re-scan is due one interval after start: startup already scans everything
  // the cursors point at, so an immediate re-scan would only burn toncenter requests.
  let lastRescan = now().getTime()
  let iteration = 0

  while (!signal.aborted) {
    // A stop request is honoured between steps, not only between iterations: after a slow
    // scan the operator should not also wait for the expirer and ten Bot API calls.
    await runStep('scan', steps.scan, log)
    if (signal.aborted) return
    await runStep('expire', steps.expire, log)
    if (signal.aborted) return
    await runStep('notify', steps.notify, log)
    if (signal.aborted) return
    if (rescanEveryMs > 0 && now().getTime() - lastRescan >= rescanEveryMs) {
      await runStep('rescan', steps.rescan, log)
      // Measured from the end of the run so a slow re-scan cannot schedule itself back-to-back.
      lastRescan = now().getTime()
    }
    iteration += 1
    options.onIteration?.(iteration)
    await sleep(pollMs, signal)
  }
}

/** setTimeout that resolves early (without rejecting) when the signal aborts. Clears the timer. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
