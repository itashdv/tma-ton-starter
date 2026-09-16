import { Address } from '@ton/core'
import { describe, expect, it } from 'vitest'

import { ENV_KEYS, EnvError, parseEnv, validateEnvAgainstShop } from './env'

const USDT_MAINNET = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const USDT_MAINNET_RAW = '0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE'
const USDT_MAINNET_UQ = 'UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p'
// Same address with a corrupted checksum suffix.
const USDT_MAINNET_BAD_CRC = 'UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_pAJ'
const TESTNET_USD = 'kQD0GKBM8ZbryVk2aESmzfU6b9b_8era_IkvBSELujFZPsyy'

const minimal = {
  DATABASE_URL: 'postgres://tma:tma@127.0.0.1:5432/tma',
  TELEGRAM_BOT_TOKEN: '123456:TEST',
  MERCHANT_WALLET: USDT_MAINNET,
}

function issuesOf(raw: Record<string, string | undefined>): string[] {
  try {
    parseEnv(raw)
    return []
  } catch (error) {
    if (error instanceof EnvError) return error.issues
    throw error
  }
}

describe('parseEnv', () => {
  it('reports every missing required key in one list', () => {
    const issues = issuesOf({})
    const joined = issues.join('\n')
    for (const key of ['TELEGRAM_BOT_TOKEN', 'DATABASE_URL', 'MERCHANT_WALLET']) {
      expect(joined).toContain(key)
    }
    expect(() => parseEnv({})).toThrowError(EnvError)
  })

  it('applies defaults', () => {
    const env = parseEnv(minimal)
    expect(env.NODE_ENV).toBe('development')
    expect(env.TELEGRAM_INITDATA_TTL_SEC).toBe(3600)
    expect(env.ORDER_TTL_MINUTES).toBe(30)
    expect(env.TX_VALID_SECONDS).toBe(300)
    expect(env.WORKER_POLL_MS).toBe(5000)
    expect(env.WORKER_BATCH_LIMIT).toBe(100)
    expect(env.WORKER_RESCAN_MINUTES).toBe(10)
    expect(env.WORKER_RESCAN_WINDOW_SEC).toBe(1800)
    expect(env.JETTON_TRANSFER_ATTACH_NANO).toBe(50_000_000n)
    expect(env.JETTON_FORWARD_NANO).toBe(1n)
    expect(env.WORKER_MIN_RECORD_NANO).toBe(1_000_000n)
    expect(env.MAX_PENDING_ORDERS_PER_USER).toBe(5)
    expect(env.TON_NETWORK).toBe('testnet')
    expect(env.tonNetworkId).toBe('-3')
    expect(env.isTestnet).toBe(true)
    expect(env.toncenterUrl).toBe('https://testnet.toncenter.com/api/v3')
    expect(env.usdtMaster).toBeNull()
  })

  it('treats blank values as unset', () => {
    const env = parseEnv({ ...minimal, TONCENTER_API_KEY: '', TELEGRAM_ADMIN_IDS: '  ' })
    expect(env.TONCENTER_API_KEY).toBeUndefined()
    expect(env.adminIds.size).toBe(0)
  })

  it('parses TELEGRAM_ADMIN_IDS into a set of strings', () => {
    expect(parseEnv({ ...minimal, TELEGRAM_ADMIN_IDS: '' }).adminIds).toEqual(new Set())
    expect(parseEnv({ ...minimal, TELEGRAM_ADMIN_IDS: ' 1, 2 ,,3 ' }).adminIds).toEqual(
      new Set(['1', '2', '3']),
    )
    expect(issuesOf({ ...minimal, TELEGRAM_ADMIN_IDS: '1,abc' })).toContainEqual(
      expect.stringContaining('TELEGRAM_ADMIN_IDS'),
    )
  })

  it('derives the network id and toncenter URL, allowing an override', () => {
    const mainnet = parseEnv({ ...minimal, TON_NETWORK: 'mainnet', TONCENTER_API_KEY: 'k' })
    expect(mainnet.tonNetworkId).toBe('-239')
    expect(mainnet.toncenterUrl).toBe('https://toncenter.com/api/v3')
    const overridden = parseEnv({ ...minimal, TONCENTER_API_URL: 'http://127.0.0.1:9999/api/v3' })
    expect(overridden.toncenterUrl).toBe('http://127.0.0.1:9999/api/v3')
  })

  it('normalises the merchant address to one raw form regardless of input form', () => {
    for (const form of [
      USDT_MAINNET,
      USDT_MAINNET_UQ,
      USDT_MAINNET_RAW,
      USDT_MAINNET_RAW.toLowerCase(),
    ]) {
      expect(parseEnv({ ...minimal, MERCHANT_WALLET: form }).merchantRaw, form).toBe(
        USDT_MAINNET_RAW,
      )
    }
    expect(issuesOf({ ...minimal, MERCHANT_WALLET: 'not-an-address' })).toContainEqual(
      expect.stringContaining('MERCHANT_WALLET'),
    )
    expect(issuesOf({ ...minimal, MERCHANT_WALLET: USDT_MAINNET_BAD_CRC })).toContainEqual(
      expect.stringContaining('MERCHANT_WALLET'),
    )
  })

  it('rejects malformed raw addresses that the TON library would silently truncate', () => {
    for (const bad of [
      `${USDT_MAINNET_RAW}0`, // 65 hex chars
      `${USDT_MAINNET_RAW}zz`, // trailing junk
      `abc:${USDT_MAINNET_RAW.slice(2)}`, // non-numeric workchain
      `5:${USDT_MAINNET_RAW.slice(2)}`, // unknown workchain
      USDT_MAINNET_RAW.slice(0, -2), // 62 hex chars
    ]) {
      expect(issuesOf({ ...minimal, MERCHANT_WALLET: bad }), bad).toContainEqual(
        expect.stringContaining('MERCHANT_WALLET'),
      )
    }
    expect(parseEnv({ ...minimal, MERCHANT_WALLET: `-1:${'a'.repeat(64)}` }).merchantRaw).toBe(
      `-1:${'A'.repeat(64)}`,
    )
  })

  it('rejects a test-only address form on mainnet', () => {
    const issues = issuesOf({
      ...minimal,
      TON_NETWORK: 'mainnet',
      TONCENTER_API_KEY: 'k',
      MERCHANT_WALLET: TESTNET_USD,
    })
    expect(issues).toContainEqual(expect.stringContaining('MERCHANT_WALLET'))
    const nonBounceableTestOnly = Address.parse(TESTNET_USD).toString({
      testOnly: true,
      bounceable: false,
    })
    expect(nonBounceableTestOnly.startsWith('0Q')).toBe(true)
    expect(
      issuesOf({
        ...minimal,
        TON_NETWORK: 'mainnet',
        TONCENTER_API_KEY: 'k',
        MERCHANT_WALLET: nonBounceableTestOnly,
      }),
    ).toContainEqual(expect.stringContaining('MERCHANT_WALLET'))
    expect(
      issuesOf({
        ...minimal,
        TON_NETWORK: 'mainnet',
        TONCENTER_API_KEY: 'k',
        USDT_JETTON_MASTER: TESTNET_USD,
      }),
    ).toContainEqual(expect.stringContaining('USDT_JETTON_MASTER'))
    expect(issuesOf({ ...minimal, MERCHANT_WALLET: TESTNET_USD })).toEqual([])
  })

  it('requires CORS_ORIGINS and TONCENTER_API_KEY in production', () => {
    const issues = issuesOf({ ...minimal, NODE_ENV: 'production' })
    expect(issues).toContainEqual(expect.stringContaining('CORS_ORIGINS'))
    expect(issues).toContainEqual(expect.stringContaining('TONCENTER_API_KEY'))
    expect(
      issuesOf({
        ...minimal,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://shop.example.com',
        TONCENTER_API_KEY: 'key',
      }),
    ).toEqual([])
  })

  it('validates numeric ranges and rejects unknown ranges', () => {
    expect(issuesOf({ ...minimal, TX_VALID_SECONDS: '600' })).toContainEqual(
      expect.stringContaining('TX_VALID_SECONDS'),
    )
    expect(issuesOf({ ...minimal, WORKER_BATCH_LIMIT: '1001' })).toContainEqual(
      expect.stringContaining('WORKER_BATCH_LIMIT'),
    )
    expect(issuesOf({ ...minimal, API_PORT: 'abc' })).toContainEqual(
      expect.stringContaining('API_PORT'),
    )
    expect(issuesOf({ ...minimal, JETTON_FORWARD_NANO: '0' })).toContainEqual(
      expect.stringContaining('JETTON_FORWARD_NANO'),
    )
    expect(issuesOf({ ...minimal, TELEGRAM_TEST_DC: 'yes' })).toContainEqual(
      expect.stringContaining('TELEGRAM_TEST_DC'),
    )
  })

  it('rejects a jetton wallet pin without a jetton master to check it against', () => {
    expect(issuesOf({ ...minimal, MERCHANT_USDT_JETTON_WALLET: TESTNET_USD })).toContainEqual(
      expect.stringContaining('MERCHANT_USDT_JETTON_WALLET'),
    )
    expect(
      issuesOf({
        ...minimal,
        MERCHANT_WALLET: TESTNET_USD,
        USDT_JETTON_MASTER: TESTNET_USD,
        MERCHANT_USDT_JETTON_WALLET: TESTNET_USD,
      }),
    ).toEqual([])
  })

  it('does not know a USDT_DECIMALS key (decimals live in config/shop.json)', () => {
    expect(ENV_KEYS).not.toContain('USDT_DECIMALS')
    expect(ENV_KEYS).toContain('USDT_JETTON_MASTER')
  })

  it('rejects CORS_ORIGINS entries that are not exact origins', () => {
    for (const bad of [
      'shop.example.com',
      'https://shop.example.com/',
      'https://shop.example.com/app',
    ]) {
      expect(issuesOf({ ...minimal, CORS_ORIGINS: bad }), bad).toContainEqual(
        expect.stringContaining('CORS_ORIGINS'),
      )
    }
    expect(issuesOf({ ...minimal, CORS_ORIGINS: 'http://localhost:3000' })).toEqual([])
  })

  it('parses CORS_ORIGINS as a list', () => {
    expect(
      parseEnv({ ...minimal, CORS_ORIGINS: 'http://a.test, https://b.test' }).CORS_ORIGINS,
    ).toEqual(['http://a.test', 'https://b.test'])
  })
})

describe('validateEnvAgainstShop', () => {
  it('requires USDT_JETTON_MASTER when the shop enables USDT', () => {
    const env = parseEnv(minimal)
    expect(() => validateEnvAgainstShop(env, { currencies: ['TON', 'USDT'] })).toThrowError(
      /USDT_JETTON_MASTER/,
    )
    expect(() => validateEnvAgainstShop(env, { currencies: ['TON'] })).not.toThrow()
    const withMaster = parseEnv({ ...minimal, USDT_JETTON_MASTER: TESTNET_USD })
    expect(() => validateEnvAgainstShop(withMaster, { currencies: ['TON', 'USDT'] })).not.toThrow()
  })
})
