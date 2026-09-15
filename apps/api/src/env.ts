import { Address } from '@ton/core'
import type { ShopConfig } from '@tma/shared'
import { z } from 'zod'

/**
 * Environment is parsed once at startup into a typed object. Every problem is reported in one
 * list so a misconfigured server fails fast with a complete picture instead of one error at a
 * time. Blank values (`KEY=`) count as unset so that .env.example placeholders behave.
 */

export class EnvError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`invalid environment:\n  - ${issues.join('\n  - ')}`)
    this.name = 'EnvError'
    this.issues = issues
  }
}

const intString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))

const bigintString = z.string().regex(/^\d+$/, 'must be an unsigned integer').transform(BigInt)

const boolString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
)

const addressString = z.string().refine((value) => {
  try {
    parseAddress(value)
    return true
  } catch {
    return false
  }
}, 'must be a valid TON address (friendly or raw form)')

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_VERSION: z.string().default('dev'),

  DATABASE_URL: z.string().min(1),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: intString(1, 65_535).default(3001),
  CORS_ORIGINS: csv.default([]),

  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/, 'must look like <bot_id>:<secret>'),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/)
    .optional(),
  TELEGRAM_MINIAPP_SHORT_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{3,64}$/)
    .optional(),
  TELEGRAM_ADMIN_IDS: csv.default([]),
  TELEGRAM_INITDATA_TTL_SEC: intString(60, 86_400 * 7).default(3600),
  TELEGRAM_BOT_API_BASE: z.url().default('https://api.telegram.org'),
  TELEGRAM_TEST_DC: boolString.default(false),

  TON_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
  TONCENTER_API_URL: z.url().optional(),
  TONCENTER_API_KEY: z.string().optional(),
  MERCHANT_WALLET: addressString,
  MERCHANT_USDT_JETTON_WALLET: addressString.optional(),
  USDT_JETTON_MASTER: addressString.optional(),
  JETTON_TRANSFER_ATTACH_NANO: bigintString.default(50_000_000n),
  JETTON_FORWARD_NANO: bigintString.default(1n),

  TX_VALID_SECONDS: intString(30, 300).default(300),
  ORDER_TTL_MINUTES: intString(1, 24 * 60).default(30),
  MAX_PENDING_ORDERS_PER_USER: intString(1, 100).default(5),

  WORKER_POLL_MS: intString(500, 600_000).default(5000),
  WORKER_BATCH_LIMIT: intString(1, 1000).default(100),
  WORKER_RESCAN_MINUTES: intString(0, 24 * 60).default(10),
  WORKER_RESCAN_WINDOW_SEC: intString(60, 7 * 86_400).default(1800),
  WORKER_MIN_RECORD_NANO: bigintString.default(1_000_000n),
})

export type RawEnv = z.infer<typeof rawEnvSchema>

/** Environment variable names the API and worker read (single source of truth for .env.example). */
export const ENV_KEYS = Object.keys(rawEnvSchema.shape) as (keyof RawEnv)[]

export type TonNetworkId = '-239' | '-3'

export interface ParsedAddress {
  /** `wc:HEX` with uppercase hex, the form toncenter uses. */
  raw: string
  address: Address
  /** Flags of the friendly form the operator wrote, null for raw input. */
  testOnly: boolean | null
  bounceable: boolean | null
}

export interface Env extends RawEnv {
  tonNetworkId: TonNetworkId
  isTestnet: boolean
  toncenterUrl: string
  adminIds: Set<string>
  merchant: ParsedAddress
  merchantRaw: string
  usdtMaster: ParsedAddress | null
  usdtMasterRaw: string | null
  merchantUsdtJettonWallet: ParsedAddress | null
}

export function toRawAddress(address: Address): string {
  const [wc, hex] = address.toRawString().split(':')
  return `${wc}:${(hex ?? '').toUpperCase()}`
}

/** `Address.parseRaw` silently truncates junk and accepts a NaN workchain, so gate it first. */
const RAW_ADDRESS_RE = /^(0|-1):[0-9a-fA-F]{64}$/

export function parseAddress(value: string): ParsedAddress {
  if (Address.isFriendly(value)) {
    const parsed = Address.parseFriendly(value)
    return {
      raw: toRawAddress(parsed.address),
      address: parsed.address,
      testOnly: parsed.isTestOnly,
      bounceable: parsed.isBounceable,
    }
  }
  if (!RAW_ADDRESS_RE.test(value)) {
    throw new Error(`invalid raw address "${value}": expected <0|-1>:<64 hex chars>`)
  }
  const address = Address.parseRaw(value)
  return { raw: toRawAddress(address), address, testOnly: null, bounceable: null }
}

function stripBlank(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim()
  }
  return out
}

/** Browsers send `Origin: scheme://host[:port]` and @fastify/cors compares it byte for byte. */
function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

const TONCENTER_URLS: Record<RawEnv['TON_NETWORK'], string> = {
  mainnet: 'https://toncenter.com/api/v3',
  testnet: 'https://testnet.toncenter.com/api/v3',
}

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = rawEnvSchema.safeParse(stripBlank(raw))
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  const env = result.data
  const issues: string[] = []

  const merchant = parseAddress(env.MERCHANT_WALLET)
  const usdtMaster = env.USDT_JETTON_MASTER ? parseAddress(env.USDT_JETTON_MASTER) : null
  const merchantUsdtJettonWallet = env.MERCHANT_USDT_JETTON_WALLET
    ? parseAddress(env.MERCHANT_USDT_JETTON_WALLET)
    : null

  if (env.TON_NETWORK === 'mainnet') {
    for (const [name, parsed] of [
      ['MERCHANT_WALLET', merchant],
      ['USDT_JETTON_MASTER', usdtMaster],
      ['MERCHANT_USDT_JETTON_WALLET', merchantUsdtJettonWallet],
    ] as const) {
      if (parsed?.testOnly === true) {
        issues.push(`${name}: test-only address form (kQ/0Q) is not allowed on mainnet`)
      }
    }
  }
  for (const origin of env.CORS_ORIGINS) {
    if (!isOrigin(origin)) {
      issues.push(`CORS_ORIGINS: "${origin}" is not an origin (expected scheme://host[:port])`)
    }
  }
  if (env.NODE_ENV === 'production') {
    if (env.CORS_ORIGINS.length === 0) issues.push('CORS_ORIGINS: required in production')
    if (!env.TONCENTER_API_KEY) issues.push('TONCENTER_API_KEY: required in production')
  }
  for (const id of env.TELEGRAM_ADMIN_IDS) {
    if (!/^\d+$/.test(id)) issues.push(`TELEGRAM_ADMIN_IDS: "${id}" is not a numeric Telegram id`)
  }
  if (env.JETTON_FORWARD_NANO <= 0n) {
    issues.push('JETTON_FORWARD_NANO: must be > 0 so the merchant wallet receives a notification')
  }
  if (issues.length > 0) throw new EnvError(issues)

  return {
    ...env,
    tonNetworkId: env.TON_NETWORK === 'mainnet' ? '-239' : '-3',
    isTestnet: env.TON_NETWORK === 'testnet',
    toncenterUrl: env.TONCENTER_API_URL ?? TONCENTER_URLS[env.TON_NETWORK],
    adminIds: new Set(env.TELEGRAM_ADMIN_IDS),
    merchant,
    merchantRaw: merchant.raw,
    usdtMaster,
    usdtMasterRaw: usdtMaster?.raw ?? null,
    merchantUsdtJettonWallet,
  }
}

/** Rules that need both the environment and config/shop.json. */
export function validateEnvAgainstShop(env: Env, shop: Pick<ShopConfig, 'currencies'>): void {
  const issues: string[] = []
  if (shop.currencies.includes('USDT') && !env.usdtMaster) {
    issues.push('USDT_JETTON_MASTER: required because config/shop.json enables USDT')
  }
  if (issues.length > 0) throw new EnvError(issues)
}
