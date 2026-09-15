import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

/** Repository root, derived from this file's location (packages/db/src/cli). */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Loads the root .env (if present) without overriding variables already set. */
export function loadRootEnv(file = '.env'): void {
  dotenv.config({ path: path.join(repoRoot, file), quiet: true })
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set (see .env.example)`)
  }
  return value
}
