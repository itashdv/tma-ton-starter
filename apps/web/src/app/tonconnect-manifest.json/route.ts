import { publicEnv } from '@/lib/env'
import { shopConfig } from '@/lib/shop-config'

/**
 * Wallets fetch this file cross-origin before connecting. `url` must be exactly the origin the
 * Mini App is served from: its host becomes the app domain the wallet shows and signs.
 */
export function GET(): Response {
  const appUrl = publicEnv.appUrl.replace(/\/+$/, '')
  const manifest = {
    url: appUrl,
    name: shopConfig.name,
    iconUrl: `${appUrl}/branding/${shopConfig.branding.icon}`,
    ...(shopConfig.links?.terms ? { termsOfUseUrl: shopConfig.links.terms } : {}),
    ...(shopConfig.links?.privacy ? { privacyPolicyUrl: shopConfig.links.privacy } : {}),
  }
  return new Response(JSON.stringify(manifest), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  })
}
