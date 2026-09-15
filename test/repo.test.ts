import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ENV_KEYS } from '../apps/api/src/env'
import { WEB_DEV_ONLY_KEYS, WEB_PUBLIC_KEYS } from '../apps/web/src/lib/env'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Files git would commit: tracked plus untracked-but-not-ignored. */
function committable(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0)
}

function isIgnored(relative: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', relative], {
    cwd: root,
  })
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed for ${relative}: ${String(result.stderr)}`)
  }
  return result.status === 0
}

function read(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8')
}

function envKeys(relative: string): string[] {
  return read(relative)
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)
}

describe('repository invariants', () => {
  it('commits env examples and never real env files', () => {
    for (const example of ['.env.example', '.env.test.example']) {
      expect(isIgnored(example), example).toBe(false)
      expect(committable()).toContain(example)
    }
    for (const secret of ['.env', '.env.test', '.env.local', 'apps/web/.env.local', 'infra/.env']) {
      expect(isIgnored(secret), secret).toBe(true)
    }
    expect(
      committable().some((f) => /(^|\/)\.env(\.[^/]*)?$/.test(f) && !f.endsWith('.example')),
    ).toBe(false)
  })

  it('documents exactly the environment the code reads', () => {
    const documented = envKeys('.env.example')
    expect(new Set(documented).size, 'duplicate keys in .env.example').toBe(documented.length)
    expect([...documented].sort()).toEqual([...ENV_KEYS, ...WEB_PUBLIC_KEYS].sort())
    for (const devOnly of WEB_DEV_ONLY_KEYS) {
      expect(documented).not.toContain(devOnly)
    }
    expect(envKeys('.env.test.example')).toEqual(['TEST_DATABASE_URL'])
  })

  it('never drops tables or columns in migrations', () => {
    const dir = path.join(root, 'packages/db/drizzle')
    const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    expect(sqlFiles.length).toBeGreaterThan(0)
    for (const file of sqlFiles) {
      const sql = readFileSync(path.join(dir, file), 'utf8').toUpperCase()
      expect(sql, file).not.toContain('DROP TABLE')
      expect(sql, file).not.toContain('DROP COLUMN')
    }
  })

  it('is MIT licensed and documents changes', () => {
    expect(read('LICENSE')).toContain('MIT License')
    expect(read('docs/CHANGELOG.md')).toContain('Stage A')
  })

  it('pins exact dependency versions in every workspace', () => {
    const manifests = [
      'package.json',
      ...committable().filter((f) => /^(apps|packages)\/[^/]+\/package\.json$/.test(f)),
    ]
    for (const manifest of manifests) {
      const pkg = JSON.parse(read(manifest)) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      for (const [name, version] of Object.entries({
        ...pkg.dependencies,
        ...pkg.devDependencies,
      })) {
        if (version.startsWith('workspace:')) continue
        expect(version, `${manifest}: ${name}`).toMatch(/^\d+\.\d+\.\d+$/)
      }
    }
  })
})
