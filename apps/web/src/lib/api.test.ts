import { describe, expect, it, vi } from 'vitest'

import { ApiError, SessionExpiredError, createApiClient } from './api'

const RAW_INIT_DATA =
  'user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Vladislav%20%2B%20-%20%3F%22%7D&auth_date=1700000000&signature=&hash=' +
  'a'.repeat(64)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createApiClient', () => {
  it('sends the raw init data byte for byte', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }))
    const api = createApiClient({
      baseUrl: 'https://api.example.com',
      getInitData: () => RAW_INIT_DATA,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await api.get('/me')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/me')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`tma ${RAW_INIT_DATA}`)
    // The escaping must survive untouched, otherwise the signature check fails.
    expect(headers.Authorization).toContain('%20%2B%20-%20%3F')
  })

  it('omits the header for public endpoints', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ products: [] }))
    const api = createApiClient({
      getInitData: () => undefined,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await api.get('/products', { auth: false })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('fails fast when there is no init data', async () => {
    const api = createApiClient({
      getInitData: () => undefined,
      fetch: vi.fn() as unknown as typeof fetch,
    })
    await expect(api.get('/me')).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('maps 401 to a session error and other failures to ApiError with the code', async () => {
    const expired = createApiClient({
      getInitData: () => RAW_INIT_DATA,
      fetch: (async () =>
        jsonResponse(
          { error: { code: 'initdata_expired', message: 'too old' } },
          401,
        )) as unknown as typeof fetch,
    })
    const sessionError = await expired.get('/me').catch((error: unknown) => error)
    expect(sessionError).toBeInstanceOf(SessionExpiredError)
    expect((sessionError as ApiError).code).toBe('initdata_expired')

    const conflict = createApiClient({
      getInitData: () => RAW_INIT_DATA,
      fetch: (async () =>
        jsonResponse(
          { error: { code: 'order_limit', message: 'too many' } },
          409,
        )) as unknown as typeof fetch,
    })
    const error = await conflict.post('/orders', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(SessionExpiredError)
    expect((error as ApiError).code).toBe('order_limit')
    expect((error as ApiError).status).toBe(409)
  })

  it('reports malformed JSON instead of throwing a parser error', async () => {
    const api = createApiClient({
      getInitData: () => RAW_INIT_DATA,
      fetch: (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch,
    })
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('posts JSON bodies', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }))
    const api = createApiClient({
      getInitData: () => RAW_INIT_DATA,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await api.post('/orders', { productId: 'p1' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"productId":"p1"}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})
