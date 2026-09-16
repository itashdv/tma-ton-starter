import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  errorResponse,
  okResponse,
  startFakeBotApi,
  type FakeBotApi,
} from '../../test/helpers/fake-bot-api'
import { botApiUrl, createBotApi, redactToken, type SendOutcome } from './bot-api'

// The token also appears inside the fake's error descriptions, so a leak would be caught.
const TOKEN = '123456:SECRET_TOKEN_abc'

let fake: FakeBotApi

beforeEach(async () => {
  fake = await startFakeBotApi()
})

afterEach(async () => {
  await fake.close()
})

function api(options: { testDc?: boolean; timeoutMs?: number; baseUrl?: string } = {}) {
  return createBotApi({
    token: TOKEN,
    baseUrl: options.baseUrl ?? fake.url,
    testDc: options.testDc ?? false,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
}

function send(client = api()) {
  return client.sendMessage({ chatId: 42n, text: 'hello' })
}

function errorOf(outcome: SendOutcome): string {
  return outcome.kind === 'ok' ? '' : outcome.error
}

describe('sendMessage request', () => {
  it('posts chat_id and text as JSON without parse_mode and returns a bigint message id', async () => {
    fake.enqueue(okResponse(777))
    const outcome = await api().sendMessage({
      chatId: 42n,
      text: 'hello',
      replyMarkup: { inline_keyboard: [[{ text: 'Open', url: 'https://t.me/x/y' }]] },
      protectContent: true,
    })
    expect(outcome).toEqual({ kind: 'ok', messageId: 777n })

    const request = fake.requests.at(-1)
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe(`/bot${TOKEN}/sendMessage`)
    const body = request?.body as Record<string, unknown>
    expect(body.chat_id).toBe('42')
    expect(body.text).toBe('hello')
    expect(body.protect_content).toBe(true)
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Open', url: 'https://t.me/x/y' }]],
    })
    expect(body).not.toHaveProperty('parse_mode')
  })

  it('omits reply_markup and protect_content when not requested', async () => {
    await send()
    const body = fake.requests.at(-1)?.body as Record<string, unknown>
    expect(body).not.toHaveProperty('reply_markup')
    expect(body).not.toHaveProperty('protect_content')
  })

  it('uses the test DC path only when testDc is set', async () => {
    await send(api({ testDc: true }))
    expect(fake.requests.at(-1)?.path).toBe(`/bot${TOKEN}/test/sendMessage`)
    await send(api({ testDc: false }))
    expect(fake.requests.at(-1)?.path).toBe(`/bot${TOKEN}/sendMessage`)

    expect(botApiUrl('https://api.telegram.org/', 't', true, 'getMe')).toBe(
      'https://api.telegram.org/bott/test/getMe',
    )
    expect(botApiUrl('https://api.telegram.org', 't', false, 'getMe')).toBe(
      'https://api.telegram.org/bott/getMe',
    )
  })
})

describe('final outcomes', () => {
  it.each([
    'Forbidden: bot was blocked by the user',
    'Forbidden: user is deactivated',
    "Forbidden: bot can't initiate conversation with a user",
  ])('treats any 403 as final (%s)', async (description) => {
    fake.enqueue(errorResponse(403, description))
    const outcome = await send()
    expect(outcome.kind).toBe('final')
    expect(errorOf(outcome)).toContain('403')
  })

  it('treats 400 chat not found as final', async () => {
    fake.enqueue(errorResponse(400, 'Bad Request: chat not found'))
    expect((await send()).kind).toBe('final')
  })

  it('treats 400 message is too long as final: the same text would fail every time', async () => {
    fake.enqueue(errorResponse(400, 'Bad Request: message is too long'))
    expect((await send()).kind).toBe('final')
  })

  it('retries other 400 errors', async () => {
    fake.enqueue(errorResponse(400, 'Bad Request: something unexpected'))
    expect((await send()).kind).toBe('retry')
  })
})

describe('rate limiting', () => {
  it('reports retry_after from the response', async () => {
    fake.enqueue(errorResponse(429, 'Too Many Requests: retry after 7', { retry_after: 7 }))
    expect(await send()).toMatchObject({ kind: 'rate_limited', retryAfterSec: 7 })
  })

  it('falls back to 5 seconds when parameters are missing', async () => {
    fake.enqueue(errorResponse(429, 'Too Many Requests'))
    expect(await send()).toMatchObject({ kind: 'rate_limited', retryAfterSec: 5 })
  })
})

describe('retryable failures', () => {
  it('retries a 500', async () => {
    fake.enqueue(errorResponse(500, 'Internal Server Error'))
    expect((await send()).kind).toBe('retry')
  })

  it('retries a non-JSON body', async () => {
    fake.enqueue({ kind: 'status', status: 502, body: '<html>bad gateway</html>' })
    expect((await send()).kind).toBe('retry')
  })

  it('waits a minute on 401/404 without charging the row (bad token or base URL)', async () => {
    fake.enqueue(errorResponse(401, 'Unauthorized'))
    expect(await send()).toMatchObject({ kind: 'rate_limited', retryAfterSec: 60 })
    fake.enqueue(errorResponse(404, 'Not Found'))
    expect(await send()).toMatchObject({ kind: 'rate_limited', retryAfterSec: 60 })
  })

  it('never throws on a malformed success body', async () => {
    fake.enqueue({ kind: 'json', status: 200, body: { ok: true, result: { message_id: 'abc' } } })
    expect((await send()).kind).toBe('retry')
    fake.enqueue({ kind: 'json', status: 200, body: { ok: true, result: { message_id: 1.5 } } })
    expect((await send()).kind).toBe('retry')
    fake.enqueue({ kind: 'json', status: 200, body: { ok: true, result: { message_id: '12' } } })
    expect(await send()).toEqual({ kind: 'ok', messageId: 12n })
  })

  it('retries a connection failure', async () => {
    const outcome = await send(api({ baseUrl: 'http://127.0.0.1:1' }))
    expect(outcome.kind).toBe('retry')
  })

  it('aborts a hanging request within the timeout', async () => {
    fake.enqueue({ kind: 'hang' })
    const started = Date.now()
    const outcome = await send(api({ timeoutMs: 50 }))
    expect(outcome.kind).toBe('retry')
    expect(errorOf(outcome)).toMatch(/timeout/i)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('token redaction', () => {
  it('replaces every occurrence', () => {
    expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a <token> b <token>')
    expect(redactToken('nothing here', TOKEN)).toBe('nothing here')
    expect(redactToken('x', '')).toBe('x')
  })

  it('never leaks the token into an outcome error', async () => {
    const outcomes: SendOutcome[] = []
    for (const response of [
      errorResponse(403, `Forbidden: blocked, see ${TOKEN}`),
      errorResponse(400, `Bad Request: chat not found ${TOKEN}`),
      errorResponse(400, `Bad Request: ${TOKEN} message is too long`),
      errorResponse(429, `Too Many Requests ${TOKEN}`, { retry_after: 1 }),
      errorResponse(500, `Internal ${TOKEN}`),
      { kind: 'status' as const, status: 503, body: TOKEN },
      { kind: 'hang' as const },
    ]) {
      fake.enqueue(response)
      // The short timeout is for the hang only; a cold TCP connect can exceed 50 ms.
      outcomes.push(await send(api({ timeoutMs: response.kind === 'hang' ? 50 : 2000 })))
    }
    outcomes.push(await send(api({ baseUrl: `http://127.0.0.1:1/${TOKEN}` })))

    expect(outcomes).toHaveLength(8)
    for (const outcome of outcomes) {
      expect(outcome.kind).not.toBe('ok')
      expect(errorOf(outcome)).not.toContain(TOKEN)
    }
    // The description itself is kept, only the token is masked.
    expect(errorOf(outcomes[0] as SendOutcome)).toContain('Forbidden: blocked, see <token>')
  })
})
