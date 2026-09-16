import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** Branding assets come from config/, so a client project changes them without touching code. */
export const runtime = 'nodejs'

const ALLOWED = /^[a-z0-9._-]+\.(png|ico)$/
const CONTENT_TYPES: Record<string, string> = { png: 'image/png', ico: 'image/x-icon' }

let cachedDir: string | null = null

/** `next start` runs from apps/web, tests run from the repository root. */
function brandingDir(): string {
  if (cachedDir) return cachedDir
  const candidates = ['.', '..', '../..'].map((prefix) =>
    path.resolve(process.cwd(), prefix, 'config', 'branding'),
  )
  cachedDir = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  return cachedDir
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params
  // The name is matched against a whitelist pattern, so no path can escape the directory.
  if (!ALLOWED.test(file)) return new Response('not found', { status: 404 })
  const extension = file.split('.').pop() ?? ''
  try {
    const body = await readFile(path.join(brandingDir(), file))
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        // Wallets fetch the icon from their own origin.
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=86400',
      },
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}
