import type { ApiErrorBody } from '@tma/shared'

import { publicEnv } from './env'

/**
 * Every call carries the raw init data in `Authorization: tma <raw>`. The string is sent
 * byte for byte: re-encoding it (for example through URLSearchParams) changes the escaping
 * and breaks the signature the API checks.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** The Mini App must be reopened from Telegram: init data has a limited lifetime. */
export class SessionExpiredError extends ApiError {}

export interface ApiClientOptions {
  baseUrl?: string
  getInitData: () => string | undefined
  fetch?: typeof globalThis.fetch
}

export interface ApiClient {
  get: <T>(path: string, options?: { auth?: boolean }) => Promise<T>
  post: <T>(path: string, body: unknown) => Promise<T>
  patch: <T>(path: string, body: unknown) => Promise<T>
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const baseUrl = (options.baseUrl ?? publicEnv.apiUrl).replace(/\/+$/, '')

  async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth) {
      const raw = options.getInitData()
      if (!raw) {
        throw new SessionExpiredError(401, 'initdata_missing', 'open the shop from Telegram')
      }
      headers.Authorization = `tma ${raw}`
    }

    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()
    let payload: unknown
    try {
      payload = text ? (JSON.parse(text) as unknown) : null
    } catch {
      throw new ApiError(response.status, 'invalid_response', 'the API returned malformed JSON')
    }

    if (!response.ok) {
      const error = (payload as ApiErrorBody | null)?.error
      const code = error?.code ?? 'request_failed'
      const message = error?.message ?? `request failed with ${response.status}`
      if (response.status === 401) throw new SessionExpiredError(401, code, message)
      throw new ApiError(response.status, code, message)
    }
    return payload as T
  }

  return {
    get: <T>(path: string, opts?: { auth?: boolean }) =>
      request<T>('GET', path, undefined, opts?.auth ?? true),
    post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  }
}
