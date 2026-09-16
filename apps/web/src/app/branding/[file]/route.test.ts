import { describe, expect, it } from 'vitest'

import { shopConfig } from '@/lib/shop-config'

import { GET } from './route'

const request = new Request('http://localhost/branding/icon-180.png')

async function get(file: string) {
  return GET(request, { params: Promise.resolve({ file }) })
}

describe('GET /branding/:file', () => {
  it('serves the configured icon with wallet-friendly headers', async () => {
    const response = await get(shopConfig.branding.icon)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.length).toBeGreaterThan(0)
    // PNG magic number.
    expect([...body.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('refuses path traversal and unknown files', async () => {
    for (const file of ['../../.env', '..%2f.env', 'secret.txt', 'icon-180.PNG', 'missing.png']) {
      expect((await get(file)).status, file).toBe(404)
    }
  })
})
