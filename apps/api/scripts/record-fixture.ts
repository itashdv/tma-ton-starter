import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import dotenv from 'dotenv'

/**
 * Records a live toncenter v3 response as a test fixture:
 *   pnpm --filter @tma/api tc:record-fixture -- --name ton-text-comment \
 *     --path '/transactions?hash=...' [--note 'why this row'] [--force]
 * The body is written verbatim under `response`, so the fixtures reflect the real wire format
 * rather than the OpenAPI document. The API key only travels in a header and is never stored.
 */
const repoRoot = path.resolve(import.meta.dirname, '../../..')
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true })

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../test/fixtures/toncenter')
const TONCENTER_URLS: Record<string, string> = {
  mainnet: 'https://toncenter.com/api/v3',
  testnet: 'https://testnet.toncenter.com/api/v3',
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const PRINT_WIDTH = 100

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object'
}

/**
 * `JSON.stringify(value, null, 2)`, except that arrays of primitives stay on one line when
 * they fit: that is what prettier does to JSON, so a fresh recording passes `pnpm format:check`
 * as written and never needs a hand edit (fixtures must stay byte-for-byte as recorded).
 */
function toPrettyJson(value: unknown, indent = '', used = 0, trailing = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every(isPrimitive)) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
      if (used + inline.length + trailing <= PRINT_WIDTH) return inline
    }
    const inner = `${indent}  `
    const items = value.map(
      (item, i) =>
        `${inner}${toPrettyJson(item, inner, inner.length, i < value.length - 1 ? 1 : 0)}`,
    )
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const inner = `${indent}  `
    const items = entries.map(([key, item], i) => {
      const prefix = `${inner}${JSON.stringify(key)}: `
      return `${prefix}${toPrettyJson(item, inner, prefix.length, i < entries.length - 1 ? 1 : 0)}`
    })
    return `{\n${items.join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const name = arg('name')
const requestPath = arg('path')
if (!name || !requestPath) {
  fail(
    "usage: tc:record-fixture -- --name <name> --path '/transactions?hash=...' [--note ...] [--force]",
  )
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
  fail(`invalid --name "${name}": use lowercase letters, digits, -`)
if (!requestPath.startsWith('/')) fail(`--path must start with "/" (got "${requestPath}")`)
// The key belongs in the header only; a keyed URL would end up in `source`.
if (/api[_-]?key/i.test(requestPath)) fail('--path must not contain an API key')

/** .env.example ships blank values (`TONCENTER_API_URL=`), which must count as unset. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

const network = env('TON_NETWORK') ?? 'testnet'
const base = (env('TONCENTER_API_URL') ?? TONCENTER_URLS[network])?.replace(/\/+$/, '')
if (!base) fail(`unknown TON_NETWORK "${network}" and no TONCENTER_API_URL`)

const file = path.join(FIXTURES_DIR, `${name}.json`)
if (existsSync(file) && !process.argv.includes('--force')) {
  fail(`${path.relative(repoRoot, file)} exists; pass --force to overwrite`)
}

const apiKey = env('TONCENTER_API_KEY')
const source = `${base}${requestPath}`
const response = await fetch(source, {
  headers: {
    Accept: 'application/json',
    // Cloudflare answers 403 to unusual user agents, so send the same one as the client.
    'User-Agent': 'tma-ton-starter/0.1',
    ...(apiKey ? { 'X-Api-Key': apiKey } : {}),
  },
  signal: AbortSignal.timeout(15_000),
})
if (!response.ok) {
  fail(`${source} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
}
const body: unknown = await response.json()

const envelope = {
  recordedAt: new Date().toISOString(),
  network,
  source,
  note: arg('note') ?? '',
  response: body,
}
mkdirSync(FIXTURES_DIR, { recursive: true })
writeFileSync(file, `${toPrettyJson(envelope)}\n`)
console.log(`wrote ${path.relative(repoRoot, file)}`)
