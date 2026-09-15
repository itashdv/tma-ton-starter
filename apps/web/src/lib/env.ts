/**
 * Public environment keys the browser bundle reads (NEXT_PUBLIC_* are inlined at build time).
 * test/repo.test.ts compares them with .env.example.
 */
export const WEB_PUBLIC_KEYS = [
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_TWA_RETURN_URL',
] as const

/** Development-only key that lives in apps/web/.env.local, never in .env.example. */
export const WEB_DEV_ONLY_KEYS = ['NEXT_PUBLIC_TG_MOCK_INIT_DATA'] as const

/** Blank values count as unset, matching how the API treats `KEY=` in .env. */
function read(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value.trim() : fallback
}

export const publicEnv = {
  /** Empty in development: the browser calls `/api`, which next.config.ts rewrites to :3001. */
  apiUrl: read(process.env.NEXT_PUBLIC_API_URL, '/api'),
  appUrl: read(process.env.NEXT_PUBLIC_APP_URL, 'http://localhost:3000'),
  twaReturnUrl: read(process.env.NEXT_PUBLIC_TWA_RETURN_URL, ''),
}
