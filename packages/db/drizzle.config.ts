import path from 'node:path'

import dotenv from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// `pnpm db:generate` needs no database. Commands that connect read DATABASE_URL from the
// environment or the repository .env; there is deliberately no fallback URL.
// drizzle-kit loads this file as CommonJS (no import.meta) and runs from packages/db.
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), quiet: true })

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
})
