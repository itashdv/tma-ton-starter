import path from 'node:path'

import dotenv from 'dotenv'
import type { NextConfig } from 'next'

import { buildContentSecurityPolicy } from './src/lib/csp'
import { apiRewrites } from './src/lib/dev-proxy'

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
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: buildContentSecurityPolicy({
              apiUrl: process.env.NEXT_PUBLIC_API_URL ?? '',
              isDev,
            }),
          },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ]
  },
  async rewrites() {
    return apiRewrites(isDev)
  },
}

export default nextConfig
