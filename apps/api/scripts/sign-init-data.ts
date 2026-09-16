import path from 'node:path'

import dotenv from 'dotenv'

import { signMockInitData } from '../src/auth/sign-init-data'

/**
 * Prints init data signed with the real bot token, for local development outside Telegram:
 *   pnpm --filter @tma/api tg:sign-initdata -- --user-id 42
 * Paste the output into apps/web/.env.local as NEXT_PUBLIC_TG_MOCK_INIT_DATA. The API keeps
 * validating the signature, so this is a fixture, not an authentication bypass.
 */
const repoRoot = path.resolve(import.meta.dirname, '../../..')
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true })

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set (see .env.example)')
  process.exit(1)
}

const idArg = arg('user-id')
const raw = signMockInitData(token, {
  id: idArg ? Number(idArg) : 279058397,
  username: arg('username') ?? 'dev_user',
  firstName: arg('first-name') ?? 'Dev',
})

console.log(raw)
