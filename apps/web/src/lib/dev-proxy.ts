/**
 * In development the storefront proxies `/api` to the API process, so one tunnel exposes both
 * to a real Telegram client. In production the browser calls the API origin directly.
 */
export const DEV_API_ORIGIN = 'http://127.0.0.1:3001'

export interface RewriteRule {
  source: string
  destination: string
}

export function apiRewrites(isDev: boolean): RewriteRule[] {
  if (!isDev) return []
  return [{ source: '/api/:path*', destination: `${DEV_API_ORIGIN}/:path*` }]
}
