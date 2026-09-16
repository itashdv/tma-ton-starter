/**
 * `start_param` is signed by Telegram, but its value is chosen by whoever built the link, so
 * it may only steer navigation, never authorisation.
 */
export type StartTarget =
  { kind: 'order'; id: string } | { kind: 'product'; slug: string } | { kind: 'none' }

const ORDER_RE = /^order_([0-9a-hjkmnp-tv-z]{16})$/
const PRODUCT_RE = /^product_([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/

export function parseStartParam(value: string | null | undefined): StartTarget {
  if (!value) return { kind: 'none' }
  const order = ORDER_RE.exec(value)
  if (order?.[1]) return { kind: 'order', id: order[1] }
  const product = PRODUCT_RE.exec(value)
  if (product?.[1]) return { kind: 'product', slug: product[1] }
  return { kind: 'none' }
}
