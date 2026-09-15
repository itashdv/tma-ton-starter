# tma-ton-starter

Стартовый шаблон Telegram Mini App: магазин цифровых товаров с оплатой в TON и USDT
через TonConnect, без собственных смарт-контрактов. Платёж подтверждается только по данным
блокчейна (toncenter v3), а всё клиентское (товары, тексты, брендинг) живёт в `config/`.

Состояние: этап A (скелет, БД, health, dev-скрипты). Каталог, оплата, слушатель платежей,
админка и деплой добавляются следующими этапами; см. `docs/CHANGELOG.md`.

## Структура

```
apps/web         Next.js 15 (App Router), Tailwind v4, shadcn/ui — витрина (/admin появится на этапе D)
apps/api         Fastify 5 — API (src/server.ts) и воркер платежей (src/worker.ts)
packages/shared  чистый TypeScript: суммы в bigint, order-id, схемы конфига, типы API
packages/db      Drizzle ORM: схема, миграции, createDb, seed
config/          shop.json, products.json, i18n/, branding/ — единственная клиентская поверхность
infra/           docker-compose для Postgres
docs/            CHANGELOG и документация
test/            тесты инвариантов репозитория
```

## Требования

- Node.js 22 (`.nvmrc`), pnpm через corepack: `corepack enable`
- Docker (Postgres 16 из `infra/docker-compose.yml`)

## Быстрый старт

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d --wait   # Postgres на 127.0.0.1:5432, БД tma и tma_test
cp .env.example .env                                  # заполнить TELEGRAM_BOT_TOKEN, MERCHANT_WALLET
cp .env.test.example .env.test
pnpm db:migrate                                       # применить миграции Drizzle
pnpm db:seed                                          # загрузить config/products.json (insert-only)
pnpm dev                                              # web :3000, api :3001, worker
curl http://127.0.0.1:3001/health
```

## Команды

| Команда                 | Что делает                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `pnpm dev`              | web, api и worker одновременно (concurrently)                                    |
| `pnpm build`            | tsup для api/worker, next build для web                                          |
| `pnpm test`             | все проекты vitest: unit, web, integration, repo                                 |
| `pnpm test:unit`        | без базы данных                                                                  |
| `pnpm test:integration` | против `TEST_DATABASE_URL` (миграции применяются автоматически)                  |
| `pnpm lint`             | ESLint                                                                           |
| `pnpm format`           | Prettier: отформатировать (`pnpm format:check` — только проверить)               |
| `pnpm typecheck`        | tsc для корня (vitest.config.ts, test/) и во всех workspace                      |
| `pnpm db:generate`      | сгенерировать миграцию из `packages/db/src/schema.ts`                            |
| `pnpm db:migrate`       | применить миграции к `DATABASE_URL`                                              |
| `pnpm db:seed`          | загрузить товары из `config/products.json` (`--overwrite` для пересинхронизации) |

## Конфигурация

- **Один `.env` в корне** для всего репозитория: api, worker, скрипты БД и `apps/web`
  (его подгружает `next.config.ts`). Полный список и правила проверки — `apps/api/src/env.ts`,
  описание — `.env.example`. Секреты только в `.env`, который не коммитится.
- `NEXT_PUBLIC_*` встраиваются в браузерный бандл при сборке: для production задайте
  `NEXT_PUBLIC_API_URL=https://api.<домен>` до `pnpm build`. В разработке оставьте пустым,
  браузер ходит в `/api`, а Next проксирует запросы на `:3001`.
- Поля `config/` описаны в `config/README.md`. Правка `config/*` перезапускает api и worker
  в `pnpm dev` автоматически.
- Пароль Postgres в `infra/docker-compose.yml` по умолчанию `tma` и годится только для
  локальной разработки. На сервере задайте `POSTGRES_PASSWORD` (в окружении или в
  `infra/.env`) и тот же пароль в `DATABASE_URL`.

## Память на маленьком сервере

`next build` требует около 1–1.5 ГБ. На сервере с 2 ГБ ОЗУ нужен swap, и одновременно
стоит запускать только один тяжёлый процесс: остановите `pnpm dev` перед `pnpm build`.
