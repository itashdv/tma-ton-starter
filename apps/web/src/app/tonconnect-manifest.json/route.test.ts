import { afterEach, describe, expect, it, vi } from 'vitest'

import { shopConfig } from '@/lib/shop-config'

async function manifestFor(appUrl: string) {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl)
  vi.resetModules()
  const { GET } = await import('./route')
  const response = GET()
  return { response, body: (await response.json()) as Record<string, unknown> }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /tonconnect-manifest.json', () => {
  it('publishes the exact origin wallets bind to', async () => {
    const { body } = await manifestFor('https://shop.example.com')
    expect(body.url).toBe('https://shop.example.com')
    expect(body.name).toBe(shopConfig.name)
    expect(body.iconUrl).toBe(`https://shop.example.com/branding/${shopConfig.branding.icon}`)
    // The TonConnect manifest specification forbids a version field.
    expect(Object.keys(body)).not.toContain('version')
  })

  it('strips a trailing slash, which would make the icon url invalid', async () => {
    const { body } = await manifestFor('https://shop.example.com/')
    expect(body.url).toBe('https://shop.example.com')
    expect(body.iconUrl).toBe(`https://shop.example.com/branding/${shopConfig.branding.icon}`)
    expect(String(body.iconUrl)).not.toContain('//branding')
  })

  it('is fetchable by wallets from any origin', async () => {
    const { response } = await manifestFor('https://shop.example.com')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toContain('public')
  })
})
