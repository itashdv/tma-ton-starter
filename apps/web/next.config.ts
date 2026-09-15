import path from 'node:path'

import dotenv from 'dotenv'
import type { NextConfig } from 'next'

// Next reads env files only from apps/web. The project keeps one .env at the repository root,
// so load it here (existing variables win) before NEXT_PUBLIC_* values are inlined.
dotenv.config({ path: path.join(import.meta.dirname, '../../.env'), quiet: true })

const isDev = process.env.NODE_ENV === 'development'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ['@tma/shared'],
  experimental: {
    // Lower peak memory during builds on small (2 GB) servers.
    webpackMemoryOptimizations: true,
  },
  async rewrites() {
    // One dev origin for web and API so a single tunnel exposes both to a real Telegram client.
    if (!isDev) return []
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:3001/:path*' }]
  },
}

export default nextConfig
