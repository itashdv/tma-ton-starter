import { describe, expect, it } from 'vitest'

import { describeDatabaseUrl, isConnectionError, runMigrations } from './migrate'

describe('describeDatabaseUrl', () => {
  it('keeps host, port and database but drops credentials', () => {
    const described = describeDatabaseUrl('postgres://tma:s3cret@db.internal:6543/tma')
    expect(described).toBe('db.internal:6543/tma')
    expect(described).not.toContain('s3cret')
    expect(describeDatabaseUrl('postgres://tma:x@127.0.0.1/tma')).toBe('127.0.0.1:5432/tma')
    expect(describeDatabaseUrl('not a url')).toBe('(unparseable DATABASE_URL)')
  })
})

describe('isConnectionError', () => {
  it('recognises refused connections, also inside an AggregateError', () => {
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(
      isConnectionError(
        new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })]),
      ),
    ).toBe(true)
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    expect(isConnectionError(new Error('Failed query: CREATE SCHEMA', { cause: refused }))).toBe(
      true,
    )
    expect(isConnectionError(Object.assign(new Error('x'), { code: '42P01' }))).toBe(false)
    expect(isConnectionError(new Error('Failed query', { cause: new Error('syntax error') }))).toBe(
      false,
    )
    expect(isConnectionError('ECONNREFUSED')).toBe(false)
  })
})

describe('runMigrations', () => {
  it('explains how to start Postgres when nothing listens, without leaking the password', async () => {
    const error = await runMigrations('postgres://tma:s3cret@127.0.0.1:1/tma_test').catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('Postgres is not reachable at 127.0.0.1:1/tma_test')
    expect(message).toContain('docker compose -f infra/docker-compose.yml up -d --wait')
    expect(message).not.toContain('s3cret')
  })
})
