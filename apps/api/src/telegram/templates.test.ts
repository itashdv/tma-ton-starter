import { describe, expect, it } from 'vitest'

import { testShop } from '../../test/helpers/build-app'
import {
  TELEGRAM_MESSAGE_MAX,
  orderDeepLink,
  renderOrderPaid,
  resolveLocale,
  type OrderPaidInput,
} from './templates'

const ORDER_ID = '0123456789abcdef'
const shop = testShop()

function input(overrides: Partial<OrderPaidInput> = {}): OrderPaidInput {
  return {
    orderId: ORDER_ID,
    productTitle: 'Guide',
    languageCode: 'en',
    delivery: { payload: 'https://example.com/download', deliverInChat: false },
    deepLink: null,
    ...overrides,
  }
}

describe('resolveLocale', () => {
  it('uses the Telegram language when the shop has it', () => {
    expect(resolveLocale(shop, 'en')).toBe('en')
    expect(resolveLocale(shop, 'ru')).toBe('ru')
  })

  it('falls back to the shop default for unknown or missing languages', () => {
    expect(shop.shop.defaultLocale).toBe('ru')
    expect(resolveLocale(shop, 'de')).toBe('ru')
    expect(resolveLocale(shop, null)).toBe('ru')
    expect(resolveLocale(shop, '')).toBe('ru')
  })

  it('maps a regional tag to its primary language and ignores case', () => {
    expect(resolveLocale(shop, 'en-GB')).toBe('en')
    expect(resolveLocale(shop, 'EN')).toBe('en')
    expect(resolveLocale(shop, 'ru_RU')).toBe('ru')
    expect(resolveLocale(shop, 'pt-BR')).toBe('ru')
  })
})

describe('orderDeepLink', () => {
  it('points at the Mini App with the order start parameter', () => {
    expect(
      orderDeepLink(
        { TELEGRAM_BOT_USERNAME: 'my_shop_bot', TELEGRAM_MINIAPP_SHORT_NAME: 'shop' },
        ORDER_ID,
      ),
    ).toBe(`https://t.me/my_shop_bot/shop?startapp=order_${ORDER_ID}`)
  })

  it('is null when either setting is missing', () => {
    expect(orderDeepLink({ TELEGRAM_BOT_USERNAME: 'my_shop_bot' }, ORDER_ID)).toBeNull()
    expect(orderDeepLink({ TELEGRAM_MINIAPP_SHORT_NAME: 'shop' }, ORDER_ID)).toBeNull()
    expect(orderDeepLink({}, ORDER_ID)).toBeNull()
  })
})

describe('renderOrderPaid', () => {
  it('substitutes the order id and product title', () => {
    const message = renderOrderPaid(shop, input({ productTitle: 'TON Guide' }))
    expect(message.text).toBe(`Order ${ORDER_ID} paid: TON Guide`)
    expect(message.text).not.toContain('{{')
  })

  it('picks the locale from the user language and falls back to the default', () => {
    expect(renderOrderPaid(shop, input({ languageCode: 'en' })).text).toBe(
      `Order ${ORDER_ID} paid: Guide`,
    )
    expect(renderOrderPaid(shop, input({ languageCode: 'de' })).text).toBe(
      `Заказ ${ORDER_ID} оплачен: Guide`,
    )
    expect(renderOrderPaid(shop, input({ languageCode: null })).text).toBe(
      `Заказ ${ORDER_ID} оплачен: Guide`,
    )
  })

  it('reveals the payload and protects the message only when the product opts in', () => {
    const revealed = renderOrderPaid(
      shop,
      input({ delivery: { payload: 'KEY-123', deliverInChat: true } }),
    )
    expect(revealed.text).toBe(`Order ${ORDER_ID} paid: Guide\n\nKEY-123`)
    expect(revealed.protectContent).toBe(true)

    const hidden = renderOrderPaid(
      shop,
      input({ delivery: { payload: 'KEY-123', deliverInChat: false } }),
    )
    expect(hidden.text).toBe(`Order ${ORDER_ID} paid: Guide`)
    expect(hidden.text).not.toContain('KEY-123')
    expect(hidden.protectContent).toBe(false)

    const empty = renderOrderPaid(shop, input({ delivery: { payload: null, deliverInChat: true } }))
    expect(empty.text).toBe(`Order ${ORDER_ID} paid: Guide`)
    expect(empty.protectContent).toBe(false)
  })

  it('truncates a long payload to the Telegram limit and keeps the header intact', () => {
    const payload = 'x'.repeat(10_000)
    const message = renderOrderPaid(shop, input({ delivery: { payload, deliverInChat: true } }))
    expect(message.text).toHaveLength(TELEGRAM_MESSAGE_MAX)
    expect(message.text.startsWith(`Order ${ORDER_ID} paid: Guide\n\nxxx`)).toBe(true)
    expect(message.text.endsWith('…')).toBe(true)
  })

  it('counts UTF-16 units like Telegram and never splits a surrogate pair', () => {
    const noLoneSurrogates = (text: string) =>
      Array.from(text).every((c) => {
        const code = c.codePointAt(0) ?? 0
        return code < 0xd800 || code > 0xdfff
      })

    const emoji = renderOrderPaid(
      shop,
      input({ delivery: { payload: '😀'.repeat(5000), deliverInChat: true } }),
    )
    expect(emoji.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX)
    expect(emoji.text.endsWith('😀…')).toBe(true)
    expect(noLoneSurrogates(emoji.text)).toBe(true)

    // One emoji in the title is the realistic trigger: 4096 code points would be 4097 units.
    const title = renderOrderPaid(
      shop,
      input({
        productTitle: '🔥 Guide',
        delivery: { payload: 'x'.repeat(5000), deliverInChat: true },
      }),
    )
    expect(title.text).toHaveLength(TELEGRAM_MESSAGE_MAX)
    expect(title.text.startsWith(`Order ${ORDER_ID} paid: 🔥 Guide`)).toBe(true)
    expect(noLoneSurrogates(title.text)).toBe(true)

    const exact = renderOrderPaid(
      shop,
      input({ delivery: { payload: 'y'.repeat(TELEGRAM_MESSAGE_MAX), deliverInChat: true } }),
    )
    expect(exact.text).toHaveLength(TELEGRAM_MESSAGE_MAX)
  })

  it('adds the open button only when a deep link exists', () => {
    const url = `https://t.me/my_shop_bot/shop?startapp=order_${ORDER_ID}`
    const withButton = renderOrderPaid(shop, input({ deepLink: url, languageCode: 'en' }))
    expect(withButton.replyMarkup).toEqual({
      inline_keyboard: [[{ text: 'Open order', url }]],
    })
    const localised = renderOrderPaid(shop, input({ deepLink: url, languageCode: 'ru' }))
    expect(localised.replyMarkup?.inline_keyboard[0]?.[0]?.text).toBe('Открыть заказ')

    expect(renderOrderPaid(shop, input({ deepLink: null })).replyMarkup).toBeNull()
  })

  it('does not escape plain text', () => {
    const message = renderOrderPaid(shop, input({ productTitle: '<b>Guide & Co</b>' }))
    expect(message.text).toContain('<b>Guide & Co</b>')
  })
})
