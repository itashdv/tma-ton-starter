import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

/**
 * Telegram signs the launch parameters with the bot token: secret = HMAC_SHA256("WebAppData",
 * token), hash = HMAC_SHA256(secret, data_check_string), where the data check string is every
 * received `key=value` pair EXCEPT `hash`, sorted by key and joined with newlines. The newer
 * `signature` field stays in that string. Values are used exactly as received after URL
 * decoding: re-serialising the user JSON would change the escaping and break the hash.
 */

export type InitDataErrorCode =
  'initdata_missing' | 'initdata_invalid' | 'initdata_expired' | 'user_missing'

export class InitDataError extends Error {
  readonly code: InitDataErrorCode

  constructor(code: InitDataErrorCode, message: string) {
    super(message)
    this.name = 'InitDataError'
    this.code = code
  }
}

/** Telegram ids have at most 52 significant bits, so a JS number is exact. */
const telegramUserSchema = z.looseObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_premium: z.boolean().optional(),
  allows_write_to_pm: z.boolean().optional(),
  photo_url: z.string().optional(),
})

export interface TelegramUser {
  id: number
  firstName: string
  lastName: string | null
  username: string | null
  languageCode: string | null
  photoUrl: string | null
  isPremium: boolean
  allowsWriteToPm: boolean
}

export interface VerifiedInitData {
  user: TelegramUser
  authDate: number
  queryId: string | null
  startParam: string | null
  chatInstance: string | null
  /** The string exactly as received; never re-encode it. */
  raw: string
}

export interface VerifyInitDataOptions {
  /** Current time in unix seconds; injectable for tests. */
  nowSec: number
  /** Maximum age of auth_date. A future auth_date is tolerated (clock skew). */
  maxAgeSec: number
}

const HASH_RE = /^[0-9a-fA-F]{64}$/
const AUTH_DATE_RE = /^\d+$/

/** Verifies the signature and returns the trusted user. Throws InitDataError otherwise. */
export function verifyInitData(
  raw: string,
  botToken: string,
  options: VerifyInitDataOptions,
): VerifiedInitData {
  if (raw.trim().length === 0) {
    throw new InitDataError('initdata_missing', 'init data is empty')
  }

  const pairs: [string, string][] = []
  const seen = new Set<string>()
  new URLSearchParams(raw).forEach((value, key) => {
    if (seen.has(key)) {
      // Parameter pollution: two `user=` pairs would let the validator and the consumer
      // disagree about which one is authentic.
      throw new InitDataError('initdata_invalid', `duplicate init data key "${key}"`)
    }
    seen.add(key)
    pairs.push([key, value])
  })

  const hash = pairs.find(([key]) => key === 'hash')?.[1]
  if (!hash) throw new InitDataError('initdata_missing', 'init data has no hash')
  if (!HASH_RE.test(hash)) throw new InitDataError('initdata_invalid', 'hash is not 32 hex bytes')

  const dataCheckString = pairs
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', secret).update(dataCheckString).digest()
  const received = Buffer.from(hash, 'hex')
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
    throw new InitDataError('initdata_invalid', 'init data signature does not match')
  }

  const authDateRaw = pairs.find(([key]) => key === 'auth_date')?.[1]
  if (!authDateRaw || !AUTH_DATE_RE.test(authDateRaw)) {
    throw new InitDataError('initdata_invalid', 'auth_date is missing or not an integer')
  }
  const authDate = Number(authDateRaw)
  if (options.nowSec - authDate > options.maxAgeSec) {
    throw new InitDataError('initdata_expired', 'init data is too old, reopen the app')
  }

  const userRaw = pairs.find(([key]) => key === 'user')?.[1]
  if (!userRaw) {
    throw new InitDataError('user_missing', 'init data carries no user')
  }
  let parsed: z.infer<typeof telegramUserSchema>
  try {
    parsed = telegramUserSchema.parse(JSON.parse(userRaw))
  } catch {
    throw new InitDataError('initdata_invalid', 'user is not a valid Telegram user object')
  }

  const value = (key: string): string | null => pairs.find(([k]) => k === key)?.[1] ?? null

  return {
    user: {
      id: parsed.id,
      firstName: parsed.first_name,
      lastName: parsed.last_name ?? null,
      username: parsed.username ?? null,
      languageCode: parsed.language_code ?? null,
      photoUrl: parsed.photo_url ?? null,
      isPremium: parsed.is_premium ?? false,
      allowsWriteToPm: parsed.allows_write_to_pm ?? false,
    },
    authDate,
    queryId: value('query_id'),
    startParam: value('start_param'),
    chatInstance: value('chat_instance'),
    raw,
  }
}
