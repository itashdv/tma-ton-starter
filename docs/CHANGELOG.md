# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Stage D: the admin area. `/admin/*` is one Fastify plugin whose `onRequest` hooks
  (`requireTma`, then `requireAdmin`) guard every route registered under it, including
  unknown paths, so a forgotten per-route hook cannot open anything; the auth matrix test
  walks the live route table (recorded by an `onRoute` hook) and checks 401 / 403 / pass for
  each method, plus 403 for everyone when `TELEGRAM_ADMIN_IDS` is empty. Endpoints: catalogue
  management with the delivery payload and inactive products (`GET/POST /admin/products`,
  `PATCH /admin/products/:id`; prices arrive in the smallest units, at least one price is
  required, a taken slug answers 409), orders with keyset pagination by `(created_at, id)`
  (`GET /admin/orders`, `GET /admin/orders/:id` with payments and notifications,
  `POST .../cancel` for pending and expired orders, `POST .../resend-notification` for paid
  ones), the ledger (`GET /admin/payments` with a status filter and tonviewer links,
  `POST /admin/payments/:id/attach`, which runs the worker's own settlement: an underpayment
  needs `force`, a foreign asset is never accepted, and a refused attach leaves the row
  untouched) and `GET /admin/health` (per-account cursors with lag, staleness and the last
  error, ledger and outbox counters, friendly merchant addresses). The storefront gets
  `/admin` (health, products, orders, payments) behind a client-side guard that only mirrors
  the API decision, and an admin link in the header for administrators.
- Stage C: the payment listener. `apps/api/src/worker.ts` is now a real process: it takes a
  Postgres advisory lock on a dedicated connection (a second instance exits 3), checks that the
  merchant wallet is active and that the derived USDT jetton wallet and on-chain decimals match
  the configuration (exit 2 otherwise), registers a scan cursor per account at the account
  head, and loops scan → expire → notify with a periodic safety re-scan. The scanner reads
  `/transactions?account&start_lt&sort=asc&limit` per account, consumes only rows with
  `finality: finalized`, `emulated: false` and a masterchain seqno, classifies them from the
  raw message body (TON text-comment transfers on the main wallet; successful
  `internal_transfer` on the merchant jetton wallet for USDT; foreign jettons, mints and
  unknown layouts land in the ledger as `ignored`), and settles each one in a single database
  transaction: ledger insert with `ON CONFLICT (tx_hash) DO NOTHING`, `SELECT ... FOR UPDATE`
  on the order, compare-and-set to `paid`, outbox row for the notification, cursor advance with
  a `GREATEST` guard. Underpayments, currency mismatches, unknown comments, paid or cancelled
  orders are recorded with a reason and never credit anything; overpayments and late payments
  (`paid_late`) are accepted. The notifier claims outbox rows with `FOR UPDATE SKIP LOCKED`,
  sends plain-text Bot API messages outside any transaction and applies 403/400-final,
  429-retry_after and exponential 5xx backoff up to 8 attempts. Live toncenter v3 fixtures were
  recorded from testnet with `pnpm --filter @tma/api tc:record-fixture` and drive the schema
  and classification tests. Design notes: `docs/PAYMENTS.md`.
- Migration `0002_scan_cursor_start_lt`: `scan_cursors.start_lt` remembers the account head at
  registration, so the safety re-scan never ingests history from before the worker's first
  start. Hardening from review: Telegram message length is counted in UTF-16 units and a
  too-long text is final rather than retried; 401/404 from the Bot API back off for a minute
  without charging the row; the pg pool has an error listener (an idle connection drop no
  longer kills the process); a stop signal is honoured between loop steps, scanner pages and
  toncenter retries; an aborted transfer with an unknown bounce flag is not credited; a
  jetton wallet pin without a jetton master is rejected at startup.
- Stage B: Telegram authentication and the payment flow up to the wallet. The API validates
  raw init data with HMAC-SHA256 on every request (`Authorization: tma <raw>`), upserts the
  Telegram profile, serves the catalogue, and creates orders whose amount, destination and
  16-character payment comment are decided server-side. TonConnect messages are built on the
  API (`@ton/core` stays out of the browser bundle, enforced by a test): a plain text comment
  for TON and a TEP-74 jetton transfer addressed to the payer jetton wallet for USDT, with the
  payer wallet resolved once through toncenter and cached. The storefront (catalogue, pay
  button, order page with polling, write-access hint) runs behind a Content-Security-Policy
  that lists the Telegram frame ancestors and the wallet bridges, and serves the TonConnect
  manifest and branding from `config/`. `POST /orders/:id/submitted` stores the TEP-467
  normalized external message hash for progress display only: nothing here confirms a payment.
- `pnpm --filter @tma/api tg:sign-initdata` prints signed init data for development outside
  Telegram; the API still checks the signature, so there is no authentication bypass.
- The storefront speaks the language of the Telegram user when the shop ships it, keeps polling
  an order through a dropped connection, tells the user to reopen the app when the launch
  credential expires, refuses a wallet on the wrong network before creating an order, and falls
  back to the "open from Telegram" panel instead of a blank page when the SDK throws. A
  notification deep link (`?startapp=order_<id>`) opens that order.

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
