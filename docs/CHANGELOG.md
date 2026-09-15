# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Stage A: monorepo skeleton (pnpm workspaces, shared TypeScript config, ESLint, Prettier,
  Vitest projects unit/web/integration/repo), config layer (`config/shop.json`,
  `config/products.json`, `config/i18n`), `@tma/shared` (amount arithmetic in bigint,
  order ids, config schemas), `@tma/db` (Drizzle schema for users, products, orders,
  payments, scan_cursors, notifications; initial migration; migrate and seed scripts),
  `@tma/api` (env validation, Fastify app, `GET /health`, worker stub), `@tma/web`
  (Next.js App Router skeleton with Tailwind v4), Postgres docker-compose, dev scripts.
- Pinned toolchain: Node 22, pnpm 11.9.0, TypeScript 5.9.3, ESLint 10.10.0, Prettier 3.9.6,
  Vitest 4.1.11, Next.js 15.5.25, React 19.3.0, Tailwind CSS 4.3.3, Fastify 5.12.4,
  zod 4.6.5, drizzle-orm 0.45.2, drizzle-kit 0.31.10, pg 8.23.0, @ton/core 0.63.1.

- Health endpoint semantics: the most lagging scan cursor decides the worker heartbeat; a
  cursor that never polled counts from its creation, so a dead scanner is reported as stale.
- Strict environment validation: raw TON addresses must be `0|-1:<64 hex>`, every
  `CORS_ORIGINS` entry must be an exact origin; `.env.example` is checked against the schema.
- Single root `.env` for all workspaces (loaded by `next.config.ts` for the web app);
  Postgres password in docker-compose is overridable via `POSTGRES_PASSWORD`.

### Changed

- Project rules: the client SDK for stages B-D is `@tma.js/sdk-react`, the
  successor of `@telegram-apps/sdk-react`; the server reverse proxy is nginx, and a Caddy
  config will ship only as an example with the deployment stage.
- ESLint 10 instead of 9: the 9.x line is marked unsupported upstream.
