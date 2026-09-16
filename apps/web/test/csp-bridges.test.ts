import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { TONCONNECT_HOSTS } from '../src/lib/csp'

/**
 * A wallet whose bridge is missing from `connect-src` cannot connect: the browser blocks the
 * event stream and the user just sees a spinner. The bridge list lives inside the installed
 * TonConnect SDK, so this test derives it from there instead of trusting a hand-written copy,
 * and fails when an SDK update introduces a wallet the policy does not allow yet.
 */
const sdkBundle = path.resolve(
  process.cwd(),
  'node_modules/.pnpm/@tonconnect+sdk@4.0.2/node_modules/@tonconnect/sdk/lib/esm/index.mjs',
)

/**
 * Every https origin the bundle uses for a bridge endpoint. Universal links (tonkeeper.com,
 * tonhub.com) are deliberately out: the page opens them, it never fetches them, so they do not
 * belong in connect-src.
 */
function bridgeOriginsFromSdk(): string[] {
  const source = readFileSync(sdkBundle, 'utf8')
  const origins = new Set<string>()
  const bridgeUrl = /https:\/\/([a-z0-9.-]+)(\/[a-z0-9/._-]*bridge[a-z0-9/._-]*)/gi
  for (const match of source.matchAll(bridgeUrl)) {
    // The staging registry is only used in the SDK's QA mode.
    if (match[1] && match[1] !== 'raw.githubusercontent.com') origins.add(`https://${match[1]}`)
  }
  return [...origins].sort()
}

describe('TonConnect bridge coverage', () => {
  it('reads the bridge list out of the installed SDK', () => {
    const origins = bridgeOriginsFromSdk()
    // A guard against the extraction silently matching nothing after an SDK layout change.
    expect(origins.length).toBeGreaterThan(10)
    expect(origins).toContain('https://bridge.tonapi.io')
  })

  it('allows every wallet bridge the SDK can fall back to', () => {
    const missing = bridgeOriginsFromSdk().filter(
      (origin) => !TONCONNECT_HOSTS.includes(origin as (typeof TONCONNECT_HOSTS)[number]),
    )
    expect(missing).toEqual([])
  })

  it('allows the wallets registry the SDK fetches at launch', () => {
    const source = readFileSync(sdkBundle, 'utf8')
    expect(source).toContain('https://config.ton.org/wallets-v2.json')
    expect(TONCONNECT_HOSTS).toContain('https://config.ton.org')
  })
})
