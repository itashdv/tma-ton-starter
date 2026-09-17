# tma-ton-starter

Стартовый шаблон Telegram Mini App: магазин цифровых товаров с оплатой в TON и USDT
через TonConnect, без собственных смарт-контрактов. Платёж подтверждается только по данным
блокчейна (toncenter v3), а всё клиентское (товары, тексты, брендинг) живёт в `config/`.

Состояние: этапы A, B и C (скелет, БД, авторизация по initData, каталог, заказы и оплата
через TonConnect, слушатель платежей с подтверждением по toncenter и уведомлениями в чат).
Админка и деплой добавляются следующими этапами; см. `docs/CHANGELOG.md`. Как именно
подтверждается платёж — `docs/PAYMENTS.md`.

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

## Telegram и кошелёк

1. Создайте бота в @BotFather, включите Mini App и задайте URL витрины.
   Токен бота положите в `TELEGRAM_BOT_TOKEN`, имя бота и short name Mini App — в
   `TELEGRAM_BOT_USERNAME` и `TELEGRAM_MINIAPP_SHORT_NAME`.
2. Манифест TonConnect отдаётся по адресу `/tonconnect-manifest.json` и собирается из
   `config/shop.json` и `NEXT_PUBLIC_APP_URL`. Хост в поле `url` должен совпадать с тем,
   с которого открывается Mini App, иначе кошелёк откажется подключаться.
3. Иконка для кошелька берётся из `config/branding/` и отдаётся по `/branding/<файл>`.
4. `MERCHANT_WALLET` должен быть задеплоен (сделайте с него один исходящий перевод).
   Для USDT укажите `USDT_JETTON_MASTER`; на testnet это ваш тестовый jetton.

## Воркер платежей

`pnpm --filter @tma/api dev:worker` (входит в `pnpm dev`) или `node apps/api/dist/worker.js`
после сборки. Воркер запускается **до** публикации магазина: курсоры регистрируются на
голове аккаунта, и платежи до первого запуска в ledger не попадают. Один воркер на базу:
второй экземпляр завершится сразу. Подробности алгоритма — `docs/PAYMENTS.md`.

| Код выхода | Причина                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| 0          | штатная остановка по SIGTERM/SIGINT                                                     |
| 1          | фатальная ошибка: неверный `.env`, toncenter недоступен при старте                      |
| 2          | кошелёк мерчанта не `active`, пин `MERCHANT_USDT_JETTON_WALLET` или decimals не совпали |
| 3          | другой экземпляр воркера держит advisory lock                                           |
| 4          | соединение, державшее lock, потеряно (перезапуск восстановит)                           |

`GET /health` показывает heartbeat воркера по `scan_cursors.last_polled_at`; ошибка
последнего опроса лежит в `scan_cursors.last_error`. Фикстуры toncenter для тестов
записываются с живого API: `pnpm --filter @tma/api tc:record-fixture -- --name <имя>
--path '/transactions?hash=<hash>'`.

## Админка

Страницы `/admin` (здоровье воркера, товары, заказы, ledger платежей) открываются только
пользователям из `TELEGRAM_ADMIN_IDS`; решение принимает API на каждый запрос, витрина лишь
прячет вкладку. Пустая переменная означает «никому». Свой Telegram id можно узнать у бота
@userinfobot или в поле `user.id` ответа `GET /me`; впишите id через запятую и перезапустите api.

- Правки товаров в админке — источник истины: `pnpm db:seed` только добавляет отсутствующие
  по `slug` товары и не перезаписывает цены, тексты и payload (это делает только `--overwrite`).
- `slug` — ключ seed-а: витрина не даёт его менять, а переименование через API приведёт к
  повторной вставке товара из `config/products.json` при следующем `pnpm db:seed`.
- Цены в форме вводятся десятичными строками (`1.5`), в API уходят в наименьших единицах.
- Платёж со статусом `unmatched` или `underpaid` можно вручную прикрепить к заказу; недоплата
  требует флага `force`, чужой актив не прикрепляется никогда. Возвраты — только вручную из
  кошелька, по адресу отправителя из ledger.

### Разработка вне Telegram

Вне Telegram нет launch-параметров, поэтому SDK не запустится. Сгенерируйте подписанные
initData и положите их в `apps/web/.env.local`:

```bash
pnpm --filter @tma/api tg:sign-initdata -- --user-id <ваш telegram id>
cp apps/web/.env.local.example apps/web/.env.local   # вставьте строку в NEXT_PUBLIC_TG_MOCK_INIT_DATA
```

Подпись проверяется бэкендом как обычно: это фикстура, а не обход авторизации. Для проверки
в настоящем Telegram поднимите туннель на порт 3000: витрина проксирует `/api` на `:3001`,
поэтому наружу нужен один адрес.

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
