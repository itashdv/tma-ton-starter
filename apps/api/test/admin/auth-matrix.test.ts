import type { InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { authHeader } from '../helpers/auth'
import { buildTestApp, testEnv, type TestApp } from '../helpers/build-app'
import { ADMIN_ID, NOW_SEC, USER_ID, adminApp, asAdmin, asUser } from './helpers'

/**
 * The route table comes from Fastify itself (an `onRoute` hook records every registration), so
 * this test covers routes that do not exist yet: a new `/admin/*` handler is checked here the
 * moment it is registered, with no list to update.
 */

const EXPECTED_ROUTES = [
  'GET /admin/health',
  'GET /admin/orders',
  'GET /admin/orders/:id',
  'GET /admin/payments',
  'GET /admin/products',
  'PATCH /admin/products/:id',
  'POST /admin/orders/:id/cancel',
  'POST /admin/orders/:id/resend-notification',
  'POST /admin/payments/:id/attach',
  'POST /admin/products',
]

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000'

let t: TestApp

beforeAll(async () => {
  t = adminApp()
  await t.app.ready()
})

afterAll(async () => {
  await t.close()
})

function adminRoutes() {
  return t.app.routeList.filter(
    (route) => route.url === '/admin' || route.url.startsWith('/admin/'),
  )
}

/** The route table stores upper-case method names; inject wants the same set as a literal type. */
function methodOf(route: { method: string }): NonNullable<InjectOptions['method']> {
  return route.method as NonNullable<InjectOptions['method']>
}

function concrete(url: string): string {
  return url.replace(':id', PLACEHOLDER_ID)
}

describe('admin route table', () => {
  it('is exactly the documented surface', () => {
    const listed = adminRoutes()
      .filter((route) => route.method !== 'HEAD')
      .map((route) => `${route.method} ${route.url}`)
      .sort()
    expect(listed).toEqual([...EXPECTED_ROUTES].sort())
    // Fastify mirrors every GET as HEAD; those must be guarded as well and are walked below.
    expect(adminRoutes().some((route) => route.method === 'HEAD')).toBe(true)
  })
})

describe('auth matrix over every /admin route', () => {
  it('anonymous → 401, ordinary user → 403, administrator → past the gate', async () => {
    const routes = adminRoutes()
    expect(routes.length).toBeGreaterThanOrEqual(EXPECTED_ROUTES.length)
    for (const route of routes) {
      const label = `${route.method} ${route.url}`
      const url = concrete(route.url)

      const anonymous = await t.app.inject({ method: methodOf(route), url })
      expect(anonymous.statusCode, `${label} anonymous`).toBe(401)
      if (route.method !== 'HEAD') {
        expect(anonymous.json(), label).toMatchObject({ error: { code: 'initdata_missing' } })
      }

      const user = await t.app.inject({ method: methodOf(route), url, headers: asUser() })
      expect(user.statusCode, `${label} non-admin`).toBe(403)
      if (route.method !== 'HEAD') {
        expect(user.json(), label).toMatchObject({ error: { code: 'forbidden' } })
      }

      const admin = await t.app.inject({ method: methodOf(route), url, headers: asAdmin() })
      expect([401, 403], `${label} admin got ${admin.statusCode}`).not.toContain(admin.statusCode)
    }
  })

  it('rejects a wrong scheme, a forged and an expired signature with 401 before any admin check', async () => {
    const bearer = await t.app.inject({
      method: 'GET',
      url: '/admin/products',
      headers: { authorization: 'Bearer something' },
    })
    expect(bearer.statusCode).toBe(401)
    expect(bearer.json()).toMatchObject({ error: { code: 'initdata_missing' } })

    const forged = await t.app.inject({
      method: 'GET',
      url: '/admin/products',
      headers: { authorization: `${asAdmin().authorization}x` },
    })
    expect(forged.statusCode).toBe(401)
    expect(forged.json()).toMatchObject({ error: { code: 'initdata_invalid' } })

    const expired = await t.app.inject({
      method: 'GET',
      url: '/admin/products',
      headers: { authorization: authHeader({ id: ADMIN_ID, authDate: NOW_SEC - 7200 }) },
    })
    expect(expired.statusCode).toBe(401)
    expect(expired.json()).toMatchObject({ error: { code: 'initdata_expired' } })
  })

  it('denies everyone, including the former administrator, when TELEGRAM_ADMIN_IDS is empty', async () => {
    const closed = buildTestApp(
      { now: () => new Date(NOW_SEC * 1000), env: testEnv({ TELEGRAM_ADMIN_IDS: '' }) },
      t.handle,
    )
    await closed.app.ready()
    try {
      for (const route of closed.app.routeList.filter((r) => r.url.startsWith('/admin'))) {
        for (const id of [ADMIN_ID, USER_ID]) {
          const response = await closed.app.inject({
            method: methodOf(route),
            url: concrete(route.url),
            headers: { authorization: authHeader({ id, authDate: NOW_SEC }) },
          })
          expect(response.statusCode, `${route.method} ${route.url} as ${id}`).toBe(403)
        }
      }
    } finally {
      await closed.app.close()
    }
  })

  it('guards unknown paths under the prefix too: 401 → 403 → 404', async () => {
    const url = '/admin/does-not-exist'
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect((await t.app.inject({ method: 'GET', url, headers: asUser() })).statusCode).toBe(403)
    const admin = await t.app.inject({ method: 'GET', url, headers: asAdmin() })
    expect(admin.statusCode).toBe(404)
    expect(admin.json()).toMatchObject({ error: { code: 'not_found' } })
    expect((await t.app.inject({ method: 'DELETE', url: '/admin/products' })).statusCode).toBe(401)
  })

  it('decides authentication before reading the body', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/admin/products',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(response.statusCode).toBe(401)
  })

  it('leaves the public routes public', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/products' })).statusCode).toBe(200)
    expect((await t.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
  })
})

describe('review follow-ups: auth matrix', () => {
  it('gates the prefix root and every method on unknown paths', async () => {
    for (const [method, url] of [
      ['GET', '/admin'],
      ['GET', '/admin/'],
      ['HEAD', '/admin/does-not-exist'],
      ['POST', '/admin/does-not-exist'],
      ['PATCH', '/admin/products'],
      ['PUT', '/admin/products/00000000-0000-4000-8000-000000000000'],
    ] as const) {
      expect((await t.app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401)
      expect(
        (await t.app.inject({ method, url, headers: asUser() })).statusCode,
        `${method} ${url} user`,
      ).toBe(403)
      expect(
        (await t.app.inject({ method, url, headers: asAdmin() })).statusCode,
        `${method} ${url} admin`,
      ).toBe(404)
    }
  })
})
