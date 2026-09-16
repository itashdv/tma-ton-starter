import { randomBytes } from 'node:crypto'

import { getTestDatabaseUrl } from '@tma/db/testing'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { acquireWorkerLock, type WorkerLock } from '../../src/worker/lock'

const url = getTestDatabaseUrl()

/** application_name is capped at 63 bytes, so keep the unique suffix short. */
function uniqueName(test: string): string {
  return `lock-test-${test}-${randomBytes(4).toString('hex')}`
}

function neverLost(reason: string): void {
  throw new Error(`onLost must not be called here: ${reason}`)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** The killed backend releases its locks while exiting, a few ms after the client notices. */
async function acquireWithRetry(applicationName: string): Promise<WorkerLock | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const lock = await acquireWorkerLock({ url, applicationName, onLost: neverLost })
    if (lock) return lock
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

async function release(lock: WorkerLock | null | undefined): Promise<void> {
  if (lock) await lock.release()
}

describe('acquireWorkerLock', () => {
  it('grants the lock to the first caller and refuses a second connection', async () => {
    let first: WorkerLock | null = null
    let second: WorkerLock | null = null
    try {
      first = await acquireWorkerLock({ url, applicationName: uniqueName('a1'), onLost: neverLost })
      expect(first).not.toBeNull()
      second = await acquireWorkerLock({
        url,
        applicationName: uniqueName('a2'),
        onLost: neverLost,
      })
      expect(second).toBeNull()
    } finally {
      await release(second)
      await release(first)
    }
  })

  it('lets another caller acquire after the holder releases', async () => {
    let second: WorkerLock | null = null
    try {
      const first = await acquireWorkerLock({
        url,
        applicationName: uniqueName('b1'),
        onLost: neverLost,
      })
      expect(first).not.toBeNull()
      await first?.release()
      second = await acquireWorkerLock({
        url,
        applicationName: uniqueName('b2'),
        onLost: neverLost,
      })
      expect(second).not.toBeNull()
    } finally {
      await release(second)
    }
  })

  it('reports the lock as lost when the backend is terminated from outside', async () => {
    const applicationName = uniqueName('lost')
    const lost = deferred<string>()
    let lock: WorkerLock | null = null
    let next: WorkerLock | null = null
    const killer = new pg.Client({ connectionString: url, application_name: uniqueName('killer') })
    await killer.connect()
    try {
      lock = await acquireWorkerLock({ url, applicationName, onLost: lost.resolve })
      expect(lock).not.toBeNull()

      const killed = await killer.query<{ pg_terminate_backend: boolean }>(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
        [applicationName],
      )
      expect(killed.rows).toEqual([{ pg_terminate_backend: true }])

      const reason = await withTimeout(lost.promise, 5_000, 'onLost was not called')
      expect(typeof reason).toBe('string')
      expect(reason.length).toBeGreaterThan(0)

      // The lock died with the session, so a replacement worker can take it.
      next = await acquireWithRetry(uniqueName('next'))
      expect(next).not.toBeNull()
    } finally {
      await release(next)
      await release(lock)
      await killer.end()
    }
  })

  it('does not report a loss on a normal release', async () => {
    const reasons: string[] = []
    const lock = await acquireWorkerLock({
      url,
      applicationName: uniqueName('quiet'),
      onLost: (reason) => void reasons.push(reason),
    })
    expect(lock).not.toBeNull()
    await lock?.release()
    // The `end` event is emitted on a later tick; give it time to prove it stays silent.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reasons).toEqual([])
  })

  it('tolerates being released twice', async () => {
    const lock = await acquireWorkerLock({
      url,
      applicationName: uniqueName('twice'),
      onLost: neverLost,
    })
    expect(lock).not.toBeNull()
    await expect(lock?.release()).resolves.toBeUndefined()
    await expect(lock?.release()).resolves.toBeUndefined()
  })

  it('throws when the database cannot be reached', async () => {
    const unreachable = new URL(url)
    unreachable.port = '1'
    await expect(
      acquireWorkerLock({
        url: unreachable.toString(),
        applicationName: uniqueName('down'),
        connectionTimeoutMillis: 1_000,
        onLost: neverLost,
      }),
    ).rejects.toThrow()
  })
})
