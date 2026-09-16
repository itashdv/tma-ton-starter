import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// jsdom gives import.meta.url an http URL, so resolve from the vitest root instead.
const webSrc = path.resolve(process.cwd(), 'apps/web/src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

const files = sourceFiles(webSrc).map((file) => ({
  path: path.relative(webSrc, file),
  source: readFileSync(file, 'utf8'),
}))

describe('browser bundle hygiene', () => {
  it('never imports the TON libraries: the API builds every payment message', () => {
    // Matches the specifier itself, so static, dynamic, side-effect and re-export forms in
    // either quote style are all caught.
    const tonSpecifier = /['"]@ton\/|['"]@tma\/shared\/ton['"]/
    const offenders = files
      .filter((file) => !file.path.endsWith('.test.ts') && !file.path.endsWith('.test.tsx'))
      .filter((file) => tonSpecifier.test(file.source))
      .map((file) => file.path)
    expect(offenders).toEqual([])
    // The guard must actually match these shapes.
    for (const sample of [
      "import { beginCell } from '@ton/core'",
      'const c = await import("@ton/core")',
      "import '@ton/core'",
      "export * from '@tma/shared/ton'",
    ]) {
      expect(tonSpecifier.test(sample), sample).toBe(true)
    }
  })

  it('keeps the Telegram SDK behind one module', () => {
    const allowed = new Set(['lib/telegram.ts', 'instrumentation-client.ts'])
    const offenders = files
      .filter((file) => /from '@tma\.js\//.test(file.source))
      .map((file) => file.path)
      .filter((file) => !allowed.has(file))
    expect(offenders).toEqual([])
  })

  it('never renders configured text as raw HTML', () => {
    const offenders = files.filter((file) => file.source.includes('dangerouslySetInnerHTML'))
    expect(offenders.map((file) => file.path)).toEqual([])
  })

  it('marks every file that uses browser-only libraries as a client component', () => {
    const offenders = files
      .filter((file) => !file.path.includes('.test.'))
      .filter((file) => /from '@tonconnect\/ui-react'|from '@tma\.js\/sdk-react'/.test(file.source))
      .filter(
        (file) =>
          !file.source.startsWith("'use client'") && !file.path.startsWith('instrumentation'),
      )
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })
})
