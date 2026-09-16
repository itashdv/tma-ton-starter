import { translate } from '@tma/shared'

import type { LoadedShopConfig } from '../config/shop'
import type { Env } from '../env'

/**
 * Pure rendering of Bot API messages from shop config and order data. Everything is plain text
 * (no parse_mode), so product titles and delivery payloads need no escaping and cannot break
 * the markup. The locale follows the user's Telegram language when the shop has it, otherwise
 * the shop default.
 */

export interface OrderPaidInput {
  orderId: string
  productTitle: string
  /** Telegram user.language_code as stored on the user row. */
  languageCode: string | null
  delivery: { payload: string | null; deliverInChat: boolean }
  deepLink: string | null
}

export interface RenderedMessage {
  text: string
  replyMarkup: { inline_keyboard: { text: string; url: string }[][] } | null
  protectContent: boolean
}

/**
 * Bot API limit for `text`, counted in UTF-16 code units (the unit of MessageEntity offsets),
 * which is what `String.length` measures. An emoji costs two units.
 */
export const TELEGRAM_MESSAGE_MAX = 4096
const ELLIPSIS = '…'

/** `pt-BR` → `pt` when the shop has no `pt-br`; Telegram sends IETF tags in any case. */
export function resolveLocale(
  shop: Pick<LoadedShopConfig, 'shop'>,
  languageCode: string | null,
): string {
  if (!languageCode) return shop.shop.defaultLocale
  const tag = languageCode.toLowerCase()
  if (shop.shop.locales.includes(tag)) return tag
  const primary = tag.split(/[-_]/)[0] ?? ''
  if (primary && shop.shop.locales.includes(primary)) return primary
  return shop.shop.defaultLocale
}

/**
 * Direct link that opens the Mini App on the order page (apps/web parses `startapp=order_<id>`).
 * Needs both the bot username and the Mini App short name; without them there is no button.
 */
export function orderDeepLink(
  env: Pick<Env, 'TELEGRAM_BOT_USERNAME' | 'TELEGRAM_MINIAPP_SHORT_NAME'>,
  orderId: string,
): string | null {
  const bot = env.TELEGRAM_BOT_USERNAME
  const app = env.TELEGRAM_MINIAPP_SHORT_NAME
  if (!bot || !app) return null
  return `https://t.me/${bot}/${app}?startapp=order_${orderId}`
}

/** Cuts by UTF-16 units (Telegram's unit) without leaving half of a surrogate pair behind. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = max - ELLIPSIS.length
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return text.slice(0, cut) + ELLIPSIS
}

export function renderOrderPaid(shop: LoadedShopConfig, input: OrderPaidInput): RenderedMessage {
  const locale = resolveLocale(shop, input.languageCode)
  const dict = shop.i18n[locale] ?? shop.i18n[shop.shop.defaultLocale] ?? {}
  const header = translate(dict, 'notify.paid', {
    orderId: input.orderId,
    product: input.productTitle,
  })

  // The payload is revealed in chat only when the product opts in; otherwise the user reads it
  // in the Mini App and the message never carries it. protect_content stops forwarding and
  // saving of a revealed payload (best effort, not DRM).
  const reveal = input.delivery.deliverInChat && input.delivery.payload
  const text = reveal ? `${header}\n\n${input.delivery.payload}` : header

  return {
    // The header comes first, so the limit only ever eats into the payload.
    text: truncate(text, TELEGRAM_MESSAGE_MAX),
    replyMarkup: input.deepLink
      ? { inline_keyboard: [[{ text: translate(dict, 'notify.open'), url: input.deepLink }]] }
      : null,
    protectContent: Boolean(reveal),
  }
}
