import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadPublicEnv() {
  vi.resetModules()
  return (await import('./env')).publicEnv
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('publicEnv', () => {
  it('falls back to the dev rewrite when NEXT_PUBLIC_API_URL is blank or unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '')
    expect((await loadPublicEnv()).apiUrl).toBe('/api')
    vi.stubEnv('NEXT_PUBLIC_API_URL', '   ')
    expect((await loadPublicEnv()).apiUrl).toBe('/api')
  })

  it('uses the configured values when present', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://shop.example.com')
    const env = await loadPublicEnv()
    expect(env.apiUrl).toBe('https://api.example.com')
    expect(env.appUrl).toBe('https://shop.example.com')
  })
})
