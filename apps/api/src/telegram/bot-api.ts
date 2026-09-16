/**
 * Minimal Bot API client for the notifier. It never throws: every HTTP status, network error
 * and timeout is mapped to an outcome the outbox can act on, because the caller's only real
 * decisions are "done", "give up on this row" and "when to try again". The token lives in the
 * request URL, so every error string is redacted before it can reach logs or the database.
 */

export type SendOutcome =
  | { kind: 'ok'; messageId: bigint }
  /** Never retry: the user blocked the bot, is deactivated, or the chat does not exist. */
  | { kind: 'final'; error: string }
  /** Wait without charging the row: 429 (Telegram says how long) or 401/404 (bad token/URL). */
  | { kind: 'rate_limited'; retryAfterSec: number; error: string }
  /** 5xx, other 4xx, network errors, timeouts: charged to the row's attempt budget. */
  | { kind: 'retry'; error: string }

export interface InlineKeyboardButton {
  text: string
  url: string
}

export interface SendMessageParams {
  chatId: bigint
  text: string
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] } | null
  protectContent?: boolean
}

export interface BotApi {
  sendMessage(params: SendMessageParams): Promise<SendOutcome>
}

export interface BotApiOptions {
  token: string
  baseUrl: string
  /** Route calls to the test DC (`/bot<token>/test/<method>`). */
  testDc: boolean
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  userAgent?: string
}

export const BOT_API_DEFAULT_TIMEOUT_MS = 10_000
export const BOT_API_DEFAULT_RETRY_AFTER_SEC = 5
/** 401/404 mean the token or the base URL is wrong: an operator problem, not the row's. */
export const BOT_API_MISCONFIGURED_RETRY_SEC = 60

/**
 * Descriptions of a 400 that will not change on retry. Telegram answers 400 (not 403) for a
 * chat it cannot find, and the exact wording differs between DCs, hence a regex. A too-long
 * text is deterministic as well: the same message would be rejected eight times over.
 */
const FINAL_400_RE =
  /chat not found|user not found|bot was blocked|user is deactivated|USER_IS_BLOCKED|message is too long/i

/** Bot API `message_id` is an integer; anything else is treated as a transient oddity. */
function parseMessageId(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

export function botApiUrl(baseUrl: string, token: string, testDc: boolean, method: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/bot${token}/${testDc ? 'test/' : ''}${method}`
}

/** Replaces every occurrence of the token, so a URL inside an error message is safe to log. */
export function redactToken(text: string, token: string): string {
  if (token.length === 0) return text
  return text.split(token).join('<token>')
}

interface BotApiErrorBody {
  ok?: unknown
  result?: unknown
  error_code?: unknown
  description?: unknown
  parameters?: unknown
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  const causeText = cause instanceof Error ? `: ${cause.message}` : ''
  return `${error.name}: ${error.message}${causeText}`
}

function readRetryAfter(parameters: unknown): number {
  const value = (parameters as { retry_after?: unknown } | null)?.retry_after
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.ceil(value)
  return BOT_API_DEFAULT_RETRY_AFTER_SEC
}

export function createBotApi(options: BotApiOptions): BotApi {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? BOT_API_DEFAULT_TIMEOUT_MS
  const userAgent = options.userAgent ?? 'tma-ton-starter/0.1'
  const url = botApiUrl(options.baseUrl, options.token, options.testDc, 'sendMessage')
  const redact = (text: string) => redactToken(text, options.token)

  async function sendMessage(params: SendMessageParams): Promise<SendOutcome> {
    // No parse_mode: the text carries user-controlled product titles and delivery payloads,
    // and plain text is the only mode that needs no escaping.
    const body: Record<string, unknown> = {
      chat_id: params.chatId.toString(),
      text: params.text,
    }
    if (params.replyMarkup) body.reply_markup = params.replyMarkup
    if (params.protectContent) body.protect_content = true

    let response: Response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': userAgent,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return { kind: 'retry', error: redact(`sendMessage failed: ${describeError(error)}`) }
    }

    let parsed: BotApiErrorBody
    try {
      parsed = (await response.json()) as BotApiErrorBody
    } catch {
      return {
        kind: 'retry',
        error: redact(`sendMessage answered ${response.status} with a non-JSON body`),
      }
    }

    if (parsed.ok === true) {
      const messageId = parseMessageId(
        (parsed.result as { message_id?: unknown } | null)?.message_id,
      )
      if (messageId !== null) return { kind: 'ok', messageId }
      return {
        kind: 'retry',
        error: redact(`sendMessage answered ${response.status} without a message_id`),
      }
    }

    const status = typeof parsed.error_code === 'number' ? parsed.error_code : response.status
    const description = typeof parsed.description === 'string' ? parsed.description : ''
    const error = redact(`sendMessage answered ${status}: ${description || '(no description)'}`)

    if (status === 429) {
      return { kind: 'rate_limited', retryAfterSec: readRetryAfter(parsed.parameters), error }
    }
    if (status === 401 || status === 404) {
      // The whole queue would burn its attempts on a bad token; wait without charging the row.
      return { kind: 'rate_limited', retryAfterSec: BOT_API_MISCONFIGURED_RETRY_SEC, error }
    }
    if (status === 403 || (status === 400 && FINAL_400_RE.test(description))) {
      return { kind: 'final', error }
    }
    return { kind: 'retry', error }
  }

  return { sendMessage }
}
