/**
 * Hosts the TonConnect UI talks to: the wallets registry and the HTTP bridges of the wallets
 * it can open. A wallet whose bridge is missing here cannot connect, so the list is data, not
 * a guess, and new wallets may require an addition.
 */
export const TONCONNECT_HOSTS = [
  // The wallets registry itself. Without it the SDK silently falls back to a short built-in
  // list, so new wallets and changed bridge URLs never reach the app.
  'https://config.ton.org',
  // HTTP bridges of the wallets shipped in that fallback list.
  'https://walletbot.me',
  'https://bridge.tonapi.io',
  'https://connect.tonhubapi.com',
  'https://tonconnectbridge.mytonwallet.org',
  'https://sse-bridge.hot-labs.org',
  'https://bridge.dewallet.pro',
  'https://bridge.mirai.app',
  'https://bridge.uxuy.me',
  'https://tc.architecton.su',
  'https://ton-bridge.safepal.com',
  'https://ton-connect-bridge.bgwapi.io',
  'https://ton-connect-bridge.echooo.link',
  'https://connect.token.im',
  'https://go-bridge.tomo.inc',
  'https://web3-bridge.kolo.in',
  'https://wallet-bridge.fintopio.com',
  'https://blitzwallet.cfd',
  'https://tc.nicegram.app',
  'https://ton-connect.mytokenpocket.vip',
  'https://www.okx.com',
  'https://wallet.binance.com',
  'https://dapp.gateio.services',
  'https://api-node.bybit.com',
] as const

/** Telegram embeds the Mini App in an iframe from these origins. */
export const TELEGRAM_FRAME_ANCESTORS = [
  'https://web.telegram.org',
  'https://*.telegram.org',
] as const

export interface CspOptions {
  apiUrl: string
  isDev: boolean
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The Mini App runs inside Telegram's iframe, so `frame-ancestors` replaces X-Frame-Options.
 * Init data is a bearer credential for its whole lifetime: a cross-site script that reads it
 * can replay it, which is why the connect and script sources are restricted.
 */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const apiOrigin = originOf(options.apiUrl)
  const connect = ["'self'", ...(apiOrigin ? [apiOrigin] : []), ...TONCONNECT_HOSTS]
  const script = options.isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'"
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    `frame-ancestors ${TELEGRAM_FRAME_ANCESTORS.join(' ')}`,
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}
