import path from 'node:path'

import { defineConfig } from 'vitest/config'

// Four projects: pure unit tests, browser-like tests for apps/web, integration tests
// against a real Postgres (TEST_DATABASE_URL) and repository invariants.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/api/src/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
        },
      },
      {
        oxc: { jsx: { runtime: 'automatic' } },
        resolve: { alias: { '@': path.resolve(import.meta.dirname, 'apps/web/src') } },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.{ts,tsx}', 'apps/web/test/**/*.test.{ts,tsx}'],
          setupFiles: ['apps/web/test/setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['packages/db/test/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
          globalSetup: ['packages/db/test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'repo',
          environment: 'node',
          include: ['test/**/*.test.ts', 'deploy/test/**/*.test.ts'],
        },
      },
    ],
  },
})
