import { describe, expect, it } from 'vitest'

import { TELEGRAM_FRAME_ANCESTORS, TONCONNECT_HOSTS, buildContentSecurityPolicy } from './csp'

function directive(policy: string, name: string): string {
  const found = policy.split('; ').find((part) => part.startsWith(`${name} `))
  if (!found) throw new Error(`no ${name} in ${policy}`)
  return found
}

describe('buildContentSecurityPolicy', () => {
  const policy = buildContentSecurityPolicy({ apiUrl: 'https://api.example.com', isDev: false })

  it('lets Telegram embed the Mini App', () => {
    for (const host of TELEGRAM_FRAME_ANCESTORS) {
      expect(directive(policy, 'frame-ancestors')).toContain(host)
    }
  })

  it('allows the API origin and every wallet bridge', () => {
    const connect = directive(policy, 'connect-src')
    expect(connect).toContain('https://api.example.com')
    for (const host of TONCONNECT_HOSTS) expect(connect).toContain(host)
  })

  it('allows the wallets registry, without which the wallet list silently degrades', () => {
    // @tonconnect/sdk fetches https://config.ton.org/wallets-v2.json on every launch and
    // swallows the failure, falling back to a short built-in list.
    expect(TONCONNECT_HOSTS).toContain('https://config.ton.org')
    expect(directive(policy, 'connect-src')).toContain('https://config.ton.org')
  })

  it('keeps only the origin of the API url', () => {
    const withPath = buildContentSecurityPolicy({
      apiUrl: 'https://api.example.com/v3/x',
      isDev: false,
    })
    expect(directive(withPath, 'connect-src')).toContain('https://api.example.com ')
    expect(directive(withPath, 'connect-src')).not.toContain('/v3/x')
  })

  it('survives a relative API url (the dev rewrite)', () => {
    const relative = buildContentSecurityPolicy({ apiUrl: '/api', isDev: true })
    expect(directive(relative, 'connect-src')).toContain("'self'")
  })

  it('allows eval only in development', () => {
    expect(directive(policy, 'script-src')).not.toContain('unsafe-eval')
    expect(
      directive(buildContentSecurityPolicy({ apiUrl: '/api', isDev: true }), 'script-src'),
    ).toContain('unsafe-eval')
  })

  it('allows images over https and data urls for the branding', () => {
    expect(directive(policy, 'img-src')).toContain('data:')
    expect(directive(policy, 'img-src')).toContain('https:')
  })
})
