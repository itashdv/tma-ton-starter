import type { Address } from '@ton/core'
import { Cell, beginCell } from '@ton/core'
import type { z } from 'zod'

import {
  accountStatesResponseSchema,
  jettonMastersResponseSchema,
  runGetMethodResponseSchema,
  transactionsResponseSchema,
  type ToncenterTransaction,
} from './toncenter.schemas'

/**
 * toncenter is the only external dependency of the payment path, and it is rate limited
 * (1 rps without a key) and occasionally unavailable. Two policies express the two callers:
 * an HTTP request may wait ~4 s at most before answering 502, while the worker may back off
 * for a minute because nothing is waiting on it.
 */

export type ToncenterPolicyName = 'request' | 'worker'

export interface ToncenterPolicy {
  timeoutMs: number
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const TONCENTER_POLICIES: Record<ToncenterPolicyName, ToncenterPolicy> = {
  request: { timeoutMs: 2000, attempts: 2, baseDelayMs: 100, maxDelayMs: 200 },
  worker: { timeoutMs: 10_000, attempts: 5, baseDelayMs: 1000, maxDelayMs: 60_000 },
}

/** Exponential backoff with jitter, capped by the policy. Pure, so it can be tested directly. */
export function backoffDelay(policy: ToncenterPolicy, attempt: number, random: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)
  return Math.round(capped * (0.5 + random * 0.5))
}

export type ToncenterErrorKind =
  'http' | 'network' | 'timeout' | 'schema' | 'blocked' | 'contract' | 'aborted'

export class ToncenterError extends Error {
  readonly kind: ToncenterErrorKind
  readonly status: number | null
  readonly attempts: number

  constructor(kind: ToncenterErrorKind, message: string, status: number | null, attempts: number) {
    super(message)
    this.name = 'ToncenterError'
    this.kind = kind
    this.status = status
    this.attempts = attempts
  }
}

export interface ToncenterClientOptions {
  baseUrl: string
  apiKey?: string | undefined
  policy?: ToncenterPolicyName
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  /** Jitter source; injectable so tests are deterministic. */
  random?: () => number
  userAgent?: string
  /** Overrides the policy timeout; tests use a short one instead of waiting seconds. */
  timeoutMs?: number
  /**
   * Process-level stop signal. The worker policy may spend a minute in retries and backoff;
   * an aborted signal ends the call at the next attempt boundary instead.
   */
  signal?: AbortSignal
}

export interface GetTransactionsParams {
  account: string
  startLt?: bigint
  endLt?: bigint
  startUtime?: number
  limit: number
  offset?: number
  sort?: 'asc' | 'desc'
}

/** setTimeout that also wakes up on abort, so a stop request does not wait out a backoff. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

export class ToncenterClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly policy: ToncenterPolicy
  private readonly doFetch: typeof globalThis.fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly userAgent: string
  private readonly signal: AbortSignal | undefined

  constructor(options: ToncenterClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    const policy = TONCENTER_POLICIES[options.policy ?? 'request']
    this.policy = options.timeoutMs ? { ...policy, timeoutMs: options.timeoutMs } : policy
    this.doFetch = options.fetch ?? globalThis.fetch
    this.signal = options.signal
    this.sleep = options.sleep ?? ((ms) => sleepUnlessAborted(ms, this.signal))
    this.random = options.random ?? Math.random
    // Cloudflare answers 403 to unusual user agents, so send an explicit one.
    this.userAgent = options.userAgent ?? 'tma-ton-starter/0.1'
  }

  private delayFor(attempt: number): number {
    return backoffDelay(this.policy, attempt, this.random())
  }

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.policy.timeoutMs)
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout
  }

  private async call(
    path: string,
    init: RequestInit & { query?: URLSearchParams },
  ): Promise<unknown> {
    const { query, ...rest } = init
    const url = `${this.baseUrl}${path}${query && [...query.keys()].length > 0 ? `?${query.toString()}` : ''}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}),
    }

    let lastError: ToncenterError | null = null
    for (let attempt = 1; attempt <= this.policy.attempts; attempt += 1) {
      if (this.signal?.aborted) {
        throw new ToncenterError(
          'aborted',
          `toncenter ${path} aborted: worker stopping`,
          null,
          attempt,
        )
      }
      try {
        const response = await this.doFetch(url, {
          ...rest,
          headers,
          signal: this.requestSignal(),
        })
        if (response.ok) return (await response.json()) as unknown
        const text = (await response.text().catch(() => '')).slice(0, 300)
        if (response.status === 403 && /error code: \d+/i.test(text)) {
          // Cloudflare, not the API: retrying with the same request will not help.
          throw new ToncenterError(
            'blocked',
            `toncenter blocked the request: ${text}`,
            403,
            attempt,
          )
        }
        lastError = new ToncenterError(
          'http',
          `toncenter ${path} answered ${response.status}: ${text}`,
          response.status,
          attempt,
        )
        if (!isRetryableStatus(response.status)) throw lastError
      } catch (error) {
        // Errors raised inside the try block are the fatal ones (blocked, non-retryable
        // status); network and timeout failures are retried.
        if (error instanceof ToncenterError) throw error
        if (this.signal?.aborted) {
          throw new ToncenterError(
            'aborted',
            `toncenter ${path} aborted: worker stopping`,
            null,
            attempt,
          )
        }
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        lastError = new ToncenterError(
          timedOut ? 'timeout' : 'network',
          `toncenter ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
          null,
          attempt,
        )
      }
      if (attempt < this.policy.attempts) await this.sleep(this.delayFor(attempt))
    }
    throw (
      lastError ??
      new ToncenterError('network', `toncenter ${path} failed`, null, this.policy.attempts)
    )
  }

  private parse<T extends z.ZodTypeAny>(schema: T, data: unknown, path: string): z.infer<T> {
    const result = schema.safeParse(data)
    if (!result.success) {
      throw new ToncenterError(
        'schema',
        `unexpected toncenter ${path} response: ${result.error.message}`,
        null,
        1,
      )
    }
    return result.data
  }

  async getTransactions(params: GetTransactionsParams): Promise<ToncenterTransaction[]> {
    const query = new URLSearchParams({
      account: params.account,
      limit: String(params.limit),
      sort: params.sort ?? 'asc',
    })
    if (params.startLt !== undefined) query.set('start_lt', params.startLt.toString())
    if (params.endLt !== undefined) query.set('end_lt', params.endLt.toString())
    if (params.startUtime !== undefined) query.set('start_utime', String(params.startUtime))
    if (params.offset !== undefined && params.offset > 0) query.set('offset', String(params.offset))
    const data = await this.call('/transactions', { method: 'GET', query })
    return this.parse(transactionsResponseSchema, data, '/transactions').transactions
  }

  /**
   * get_wallet_address on the jetton master. Authoritative even before the wallet exists,
   * unlike /jetton/wallets which only knows wallets the indexer has already seen.
   */
  async getJettonWalletAddress(master: Address, owner: Address): Promise<Address> {
    const data = await this.call('/runGetMethod', {
      method: 'POST',
      body: JSON.stringify({
        address: master.toRawString(),
        method: 'get_wallet_address',
        stack: [
          {
            type: 'slice',
            value: beginCell().storeAddress(owner).endCell().toBoc().toString('base64'),
          },
        ],
      }),
    })
    const parsed = this.parse(runGetMethodResponseSchema, data, '/runGetMethod')
    if (parsed.exit_code !== 0) {
      throw new ToncenterError(
        'contract',
        `get_wallet_address exited with ${parsed.exit_code}`,
        null,
        1,
      )
    }
    const item = parsed.stack[0]
    if (!item || typeof item.value !== 'string') {
      throw new ToncenterError('schema', 'get_wallet_address returned no cell', null, 1)
    }
    try {
      return Cell.fromBase64(item.value).beginParse().loadAddress()
    } catch (error) {
      throw new ToncenterError(
        'schema',
        `get_wallet_address returned an unreadable cell: ${error instanceof Error ? error.message : String(error)}`,
        null,
        1,
      )
    }
  }

  async getAccountState(account: string) {
    const query = new URLSearchParams({ address: account })
    const data = await this.call('/accountStates', { method: 'GET', query })
    return this.parse(accountStatesResponseSchema, data, '/accountStates').accounts[0] ?? null
  }

  async getJettonMaster(address: string) {
    const query = new URLSearchParams({ address })
    const data = await this.call('/jetton/masters', { method: 'GET', query })
    return (
      this.parse(jettonMastersResponseSchema, data, '/jetton/masters').jetton_masters[0] ?? null
    )
  }
}

export function createToncenterClient(options: ToncenterClientOptions): ToncenterClient {
  return new ToncenterClient(options)
}
