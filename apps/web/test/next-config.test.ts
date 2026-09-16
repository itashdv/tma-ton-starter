import { describe, expect, it } from 'vitest'

import { DEV_API_ORIGIN, apiRewrites } from '../src/lib/dev-proxy'
import nextConfig from '../next.config'

describe('next.config', () => {
  it('sends a Content-Security-Policy on every route', async () => {
    const headers = await nextConfig.headers?.()
    expect(headers).toBeDefined()
    const rule = headers?.find((entry) => entry.source === '/:path*')
    const csp =
      rule?.headers.find((header) => header.key === 'Content-Security-Policy')?.value ?? ''
    expect(csp).toContain('frame-ancestors https://web.telegram.org')
    expect(csp).toContain('connect-src')
    expect(csp).toContain('https://bridge.tonapi.io')
    expect(rule?.headers.map((header) => header.key)).toContain('X-Content-Type-Options')
    // frame-ancestors replaces X-Frame-Options, which would block the Telegram iframe.
    expect(rule?.headers.map((header) => header.key)).not.toContain('X-Frame-Options')
  })

  it('proxies /api to the API in development and not otherwise', () => {
    // NODE_ENV is "test" here, so the config itself must produce no rewrite; the development
    // branch is asserted through the pure helper the config calls.
    expect(apiRewrites(false)).toEqual([])
    expect(apiRewrites(true)).toEqual([
      { source: '/api/:path*', destination: `${DEV_API_ORIGIN}/:path*` },
    ])
    expect(DEV_API_ORIGIN).toContain(':3001')
  })

  it('produces no rewrite outside development', async () => {
    const rewrites = await nextConfig.rewrites?.()
    expect(Array.isArray(rewrites) ? rewrites : []).toEqual([])
  })

  it('consumes the workspace packages as source', () => {
    expect(nextConfig.transpilePackages).toContain('@tma/shared')
  })
})
