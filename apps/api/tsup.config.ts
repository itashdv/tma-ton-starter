import { defineConfig } from 'tsup'

// Two bundles from one package: the HTTP server and the payment worker.
// Workspace packages are inlined so dist/ runs with only the external node_modules.
export default defineConfig({
  entry: { server: 'src/server.ts', worker: 'src/worker.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ['@tma/shared', '@tma/db'],
  // Dependencies of the inlined workspace packages must stay external (they are CJS and
  // resolved from node_modules at runtime, like every other dependency of this package).
  external: ['pg', 'pg-native', /^drizzle-orm/, 'zod', 'dotenv'],
})
