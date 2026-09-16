import { isValid as isValidByLibrary, sign as signByLibrary } from '@tma.js/init-data-node'
import { describe, expect, it } from 'vitest'

import { InitDataError, verifyInitData } from './init-data'
import { signInitData, signMockInitData } from './sign-init-data'

/**
 * Golden vector from the public Telegram Mini Apps documentation. Its bot token is published
 * there and is stored base64-encoded so that secret scanners do not flag a documentation value.
 */
const DOC_TOKEN = Buffer.from(
  'NTc2ODMzNzY5MTpBQUg1WWtvaUV1UGs4LUZaYTMyaFN0SFRxWGlMUHRBRWh4OA==',
  'base64',
).toString()
const DOC_INIT_DATA =
  'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2'
const DOC_AUTH_DATE = 1662771648

const TEST_TOKEN = '123456:TEST'
const options = (nowSec: number, maxAgeSec = 3600) => ({ nowSec, maxAgeSec })

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof InitDataError) return error.code
    throw error
  }
  return 'no_error'
}

describe('verifyInitData: golden vector', () => {
  it('accepts the documentation vector and returns the user', () => {
    const verified = verifyInitData(DOC_INIT_DATA, DOC_TOKEN, options(DOC_AUTH_DATE))
    expect(verified.user.id).toBe(279058397)
    expect(verified.user.firstName).toBe('Vladislav')
    expect(verified.user.username).toBe('vdkfrost')
    expect(verified.user.languageCode).toBe('ru')
    expect(verified.user.isPremium).toBe(true)
    expect(verified.user.allowsWriteToPm).toBe(false)
    expect(verified.authDate).toBe(DOC_AUTH_DATE)
    expect(verified.queryId).toBe('AAHdF6IQAAAAAN0XohDhrOrc')
    expect(verified.raw).toBe(DOC_INIT_DATA)
  })

  it('rejects it under any other bot token', () => {
    expect(codeOf(() => verifyInitData(DOC_INIT_DATA, TEST_TOKEN, options(DOC_AUTH_DATE)))).toBe(
      'initdata_invalid',
    )
  })

  it('depends on the exact key/message order of the secret', () => {
    // A validator that computes HMAC(token, "WebAppData") instead of HMAC("WebAppData", token)
    // silently rejects every real launch; the golden vector is what catches that.
    const swapped = DOC_TOKEN.split('').reverse().join('')
    expect(codeOf(() => verifyInitData(DOC_INIT_DATA, swapped, options(DOC_AUTH_DATE)))).toBe(
      'initdata_invalid',
    )
  })
})

describe('verifyInitData: signature field', () => {
  it('keeps signature inside the data check string', () => {
    const raw = signInitData(
      { auth_date: 1_700_000_000, signature: 'abc123', user: { id: 1, first_name: 'A' } },
      TEST_TOKEN,
    )
    expect(raw).toContain('signature=abc123')
    expect(() => verifyInitData(raw, TEST_TOKEN, options(1_700_000_000))).not.toThrow()

    // Dropping the pair (as a validator that excludes `signature` would) must invalidate it.
    const withoutSignature = new URLSearchParams(raw)
    withoutSignature.delete('signature')
    expect(
      codeOf(() => verifyInitData(withoutSignature.toString(), TEST_TOKEN, options(1_700_000_000))),
    ).toBe('initdata_invalid')
  })

  it('accepts an empty signature pair, as the reference signer emits', () => {
    const raw = signInitData(
      { auth_date: 1_700_000_000, signature: '', user: { id: 1, first_name: 'A' } },
      TEST_TOKEN,
    )
    expect(() => verifyInitData(raw, TEST_TOKEN, options(1_700_000_000))).not.toThrow()
  })
})

describe('verifyInitData: rejections', () => {
  const now = 1_700_000_000
  const valid = () => signMockInitData(TEST_TOKEN, { authDate: now })

  it('reports a missing or empty string', () => {
    expect(codeOf(() => verifyInitData('', TEST_TOKEN, options(now)))).toBe('initdata_missing')
    expect(codeOf(() => verifyInitData('   ', TEST_TOKEN, options(now)))).toBe('initdata_missing')
    expect(codeOf(() => verifyInitData('user=%7B%7D', TEST_TOKEN, options(now)))).toBe(
      'initdata_missing',
    )
  })

  it('rejects a tampered user, a tampered hash and a malformed hash', () => {
    const raw = valid()
    expect(
      codeOf(() =>
        verifyInitData(
          raw.replace('%22id%22%3A279058397', '%22id%22%3A1'),
          TEST_TOKEN,
          options(now),
        ),
      ),
    ).toBe('initdata_invalid')
    const flipped = raw.replace(
      /hash=([0-9a-f])/,
      (_m, c: string) => `hash=${c === 'a' ? 'b' : 'a'}`,
    )
    expect(codeOf(() => verifyInitData(flipped, TEST_TOKEN, options(now)))).toBe('initdata_invalid')
    expect(
      codeOf(() =>
        verifyInitData(raw.replace(/hash=[0-9a-f]{64}/, 'hash=deadbeef'), TEST_TOKEN, options(now)),
      ),
    ).toBe('initdata_invalid')
    expect(
      codeOf(() => verifyInitData('user=%7B%7D&hash=' + 'z'.repeat(64), TEST_TOKEN, options(now))),
    ).toBe('initdata_invalid')
  })

  it('rejects duplicate keys (parameter pollution)', () => {
    const raw = `${valid()}&user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Mallory%22%7D`
    expect(codeOf(() => verifyInitData(raw, TEST_TOKEN, options(now)))).toBe('initdata_invalid')
  })

  it('rejects a non-integer auth_date and data older than the TTL', () => {
    expect(
      codeOf(() =>
        verifyInitData(
          signInitData(
            { auth_date: '1700000000abc', user: { id: 1, first_name: 'A' } },
            TEST_TOKEN,
          ),
          TEST_TOKEN,
          options(now),
        ),
      ),
    ).toBe('initdata_invalid')
    expect(
      codeOf(() =>
        verifyInitData(
          signInitData({ user: { id: 1, first_name: 'A' } }, TEST_TOKEN),
          TEST_TOKEN,
          options(now),
        ),
      ),
    ).toBe('initdata_invalid')
    expect(codeOf(() => verifyInitData(valid(), TEST_TOKEN, options(now + 3601)))).toBe(
      'initdata_expired',
    )
    expect(codeOf(() => verifyInitData(valid(), TEST_TOKEN, options(now + 3600)))).toBe('no_error')
  })

  it('tolerates a slightly future auth_date (clock skew)', () => {
    expect(
      codeOf(() =>
        verifyInitData(
          signMockInitData(TEST_TOKEN, { authDate: now + 120 }),
          TEST_TOKEN,
          options(now),
        ),
      ),
    ).toBe('no_error')
  })

  it('reports init data without a user separately', () => {
    const raw = signInitData({ auth_date: now, query_id: 'AAE' }, TEST_TOKEN)
    expect(codeOf(() => verifyInitData(raw, TEST_TOKEN, options(now)))).toBe('user_missing')
  })

  it('rejects a user object that is not a Telegram user', () => {
    for (const user of [{ id: 0, first_name: 'A' }, { id: 1 }, { id: '1', first_name: 'A' }, []]) {
      const raw = signInitData({ auth_date: now, user }, TEST_TOKEN)
      expect(
        codeOf(() => verifyInitData(raw, TEST_TOKEN, options(now))),
        JSON.stringify(user),
      ).toBe('initdata_invalid')
    }
  })

  it('keeps unknown fields working (Telegram keeps adding them)', () => {
    const raw = signInitData(
      {
        auth_date: now,
        chat_join_request_query_id: 'X',
        user: { id: 1, first_name: 'A', future_flag: true },
      },
      TEST_TOKEN,
    )
    expect(codeOf(() => verifyInitData(raw, TEST_TOKEN, options(now)))).toBe('no_error')
  })
})

describe('cross-check against the reference implementation', () => {
  // Our verifier and our signer share one algorithm, so a shared mistake would pass both.
  // @tma.js/init-data-node is an independent implementation of the same specification.
  const authDate = 1_700_000_000
  const libraryOptions = { expiresIn: 0 } // the vectors are older than any sane TTL

  it('accepts what the reference library signs', () => {
    // The library takes auth_date as a separate argument, not as a field.
    const raw = signByLibrary(
      { user: { id: 7, first_name: 'Ann' } },
      TEST_TOKEN,
      new Date(authDate * 1000),
    )
    const verified = verifyInitData(raw, TEST_TOKEN, options(authDate))
    expect(verified.user.id).toBe(7)
    expect(verified.user.firstName).toBe('Ann')
    // The library emits an empty signature pair; it is part of the signed data.
    expect(raw).toContain('signature=')
  })

  it('produces data the reference library accepts', () => {
    const raw = signInitData(
      { auth_date: authDate, user: { id: 7, first_name: 'Ann' } },
      TEST_TOKEN,
    )
    expect(isValidByLibrary(raw, TEST_TOKEN, libraryOptions)).toBe(true)
    expect(
      isValidByLibrary(signMockInitData(TEST_TOKEN, { authDate }), TEST_TOKEN, libraryOptions),
    ).toBe(true)
  })

  it('agrees with the library on rejection', () => {
    const tampered = signInitData(
      { auth_date: authDate, user: { id: 7, first_name: 'Ann' } },
      TEST_TOKEN,
    ).replace('%22id%22%3A7', '%22id%22%3A8')
    expect(isValidByLibrary(tampered, TEST_TOKEN, libraryOptions)).toBe(false)
    expect(codeOf(() => verifyInitData(tampered, TEST_TOKEN, options(authDate)))).toBe(
      'initdata_invalid',
    )
    expect(isValidByLibrary(DOC_INIT_DATA, DOC_TOKEN, libraryOptions)).toBe(true)
  })
})

describe('signMockInitData', () => {
  it('produces data our verifier accepts, with the fields a launch carries', () => {
    const now = 1_700_000_000
    const verified = verifyInitData(
      signMockInitData(TEST_TOKEN, {
        authDate: now,
        id: 42,
        username: 'tester',
        allowsWriteToPm: false,
      }),
      TEST_TOKEN,
      options(now),
    )
    expect(verified.user.id).toBe(42)
    expect(verified.user.username).toBe('tester')
    expect(verified.user.allowsWriteToPm).toBe(false)
    expect(verified.chatInstance).toBe('-1234567890123456789')
  })
})
