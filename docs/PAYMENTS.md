# Подтверждение платежей

Как воркер (`apps/api/src/worker.ts`) превращает транзакции в блокчейне в статус `paid`
у заказа и почему он устроен именно так. Единственный источник истины — toncenter v3;
сообщения от клиента (`POST /orders/:id/submitted`) на подтверждение не влияют.

## Поток

```
кошелёк → блокчейн → toncenter v3 → scanner → classify → applyPayment → orders.paid
                                                                       └→ notifications (outbox) → notifier → Bot API
```

Цикл воркера: `scan → expire → notify → sleep(WORKER_POLL_MS)`, раз в
`WORKER_RESCAN_MINUTES` — страховочный `rescan`. Каждый шаг изолирован: исключение
логируется, следующий шаг выполняется, цикл продолжается.

## Машина состояний заказа

```
pending ──expirer──▶ expired
   │                    │
   └──applyPayment──▶ paid ◀──applyPayment (paid_late = true)
   │                    │
   └──admin cancel──▶ cancelled ◀── admin cancel
```

`paid` и `cancelled` терминальны для автоматики. `paid_late` ставится, если заказ уже был
`expired` или транзакция произошла позже `expires_at` (даже если expirer ещё не успел
сработать). `paid_at` = время транзакции в блокчейне, не время обнаружения.

## Что считается платежом

Сканируются два аккаунта: основной кошелёк мерчанта (`MERCHANT_WALLET`) и его jetton-кошелёк
для `USDT_JETTON_MASTER` (адрес вычисляется при старте через `get_wallet_address`).
Тела сообщений разбираются из сырого BoC, декодированные поля индексатора не используются.

| Аккаунт        | Входящее сообщение                                                  | Результат                                     |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| main           | TON с текстовым комментарием или пустым телом                       | TON-кандидат `{amount, sender, comment}`      |
| main           | то же без пригодного комментария и `value < WORKER_MIN_RECORD_NANO` | skip (пыль)                                   |
| main           | `bounced = true` или (`aborted` и `bounce = true`)                  | skip (деньги вернулись отправителю)           |
| main           | `aborted` при `bounce = false`                                      | кандидат с пометкой `aborted_nonbounceable`   |
| main           | `0x7362d09c` от **своего** jetton-кошелька                          | skip (зачислено на jetton-кошельке)           |
| main           | `0x7362d09c` от любого другого                                      | `ignored/unsupported_asset` + `source_wallet` |
| main           | `0xd53276db` (excesses), `0x178d4519`, внешние, `in_msg {}`         | skip                                          |
| main           | иное тело, `value ≥ WORKER_MIN_RECORD_NANO`                         | `ignored/unknown_layout`                      |
| jetton-кошелёк | `0x178d4519`, `aborted = false`, compute и action успешны           | USDT-кандидат `{amount, from, comment}`       |
| jetton-кошелёк | `0x178d4519` от мастера                                             | `ignored/from_master` (минт)                  |
| jetton-кошелёк | `0x178d4519`, тело не разобрано                                     | `ignored/unknown_layout`                      |
| jetton-кошелёк | `0x178d4519` неуспешный, всё остальное                              | skip                                          |

Почему USDT подтверждается на jetton-кошельке: `transfer_notification` на основном кошельке
приходит с `forward_ton_amount = 1 nanoTON`, этого не хватает на выполнение кода кошелька,
и транзакция почти всегда `aborted`. Зачисление jetton-ов — это успешный `internal_transfer`
на jetton-кошельке мерчанта; контракт сам отвергает отправителя, который не является
jetton-кошельком того же мастера, поэтому успешная транзакция — достаточное доказательство.

## Финальность

Транзакция потребляется только при `finality === 'finalized' && emulated === false &&
mc_block_seqno != null`. Включение шард-блока в блок мастерчейна необратимо, поэтому
«N подтверждений» не нужны. Первая нефинальная строка останавливает батч аккаунта: строки
после неё ещё не зафиксированы. Все проверки fail-closed: отсутствующее поле означает
«не финально».

## Курсор и re-scan

У каждого аккаунта — строка `scan_cursors (last_lt, last_hash)`. `lt` строго возрастает
внутри цепочки транзакций аккаунта, поэтому `start_lt=last_lt&sort=asc` — точный запрос
«всё после»; строка с `hash == last_hash` пропускается (`start_lt` включителен). Время
(`now`) для курсора не годится: оно не монотонно относительно порядка в цепочке и не
уникально.

- Курсор двигается только до последней **полностью** обработанной строки. Каждая
  записанная строка сдвигает курсор в той же транзакции БД; пропущенные строки сдвигают его
  по концу страницы или при остановке.
- Ошибка `applyPayment` прерывает батч аккаунта: курсор остаётся на предыдущей строке,
  `last_error` заполняется, следующий poll повторяет ту же строку. Постоянная ошибка
  блокирует аккаунт видимо (`last_error` в `scan_cursors`), а не теряет платёж.
- `last_polled_at` обновляется при каждом poll, включая неудачный: это heartbeat процесса
  для `/health`; `last_error` — исход.
- Первый запуск регистрирует курсор на голове аккаунта (`accountStates.last_transaction_lt`)
  и запоминает её как пол `start_lt`: история до старта воркера в ledger не попадает ни при
  сканировании, ни при re-scan. Для несуществующего jetton-кошелька — `0/null`. Аккаунт со
  статусом `active`, у которого индексатор не сообщает последнюю транзакцию, — отказ старта
  (курсор на `0` заливал бы всю историю).
- Раз в `WORKER_RESCAN_MINUTES` выполняется `rescanRecentOnce`: последние
  `WORKER_RESCAN_WINDOW_SEC` секунд по `start_utime` с `end_lt = last_lt`, только строки с
  `start_lt < lt ≤ last_lt`, `touchCursor: false`. Это страховка от лага индексатора; дубли
  отсекает `UNIQUE(tx_hash)`, а любая «восстановленная» строка попадает в лог как warning.
- SIGTERM обрабатывается на границе шага и страницы: цикл проверяет сигнал между scan,
  expire и notify, сканер — между страницами, клиент toncenter — между попытками и во время
  backoff, поэтому остановка не ждёт минуту ретраев при недоступном индексаторе.

## Exactly-once

Единственность обеспечивает Postgres, а не память процесса.

| Инвариант                                                     | Что гарантирует                                                                                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIQUE(tx_hash)`                                             | одна транзакция — одна строка ledger; `INSERT … ON CONFLICT DO NOTHING RETURNING` → `{duplicate:true}`; второе соединение ждёт коммита первого на индексе |
| `UNIQUE(account, tx_lt)`                                      | два хэша с одним `lt` — аномалия данных: батч падает громко                                                                                               |
| `UNIQUE(order_id) WHERE status='matched'`                     | у заказа максимум один зачтённый платёж — последняя линия обороны                                                                                         |
| `SELECT … FOR UPDATE` + CAS `status IN ('pending','expired')` | два платежа на один заказ сериализуются, второй записывается как `order_already_paid`                                                                     |
| одна транзакция БД на шаги 1–6                                | сбой на любом шаге откатывает всё: ledger, заказ, outbox, курсор                                                                                          |
| `GREATEST`-guard курсора                                      | курсор никогда не откатывается                                                                                                                            |
| `pg_try_advisory_lock` на выделенном соединении               | один воркер на БД: второй экземпляр выходит с кодом 3, потеря соединения — код 4                                                                          |

Шаги `applyPayment` (`apps/api/src/services/payments.ts`):

1. `INSERT INTO payments … ON CONFLICT (tx_hash) DO NOTHING RETURNING id`; нет строки →
   `{ duplicate: true }`. `ignored` → к шагу 6.
2. `normalizeComment` (trim + lowercase) → `SELECT … FROM orders WHERE id = $1 FOR UPDATE`.
3. Решение: пустой комментарий → `unmatched/no_comment`; не id или нет заказа →
   `unmatched/order_not_found`; валюта или `jetton_master` ≠ → `unmatched/currency_mismatch`;
   `paid` → `order_already_paid`; `cancelled` → `order_cancelled`; `amount < order.amount` →
   `underpaid`; иначе платёж зачитывается.
4. Зачёт: `UPDATE orders SET status='paid', paid_at=tx_now, paid_late … WHERE status IN
('pending','expired')` → `UPDATE payments SET status='matched', order_id, payer_mismatch`
   → `INSERT INTO notifications … ON CONFLICT (order_id, kind) DO NOTHING`.
5. Иначе `UPDATE payments SET status, reason, order_id`.
6. `advanceCursor(account, lt, hash)` при `touchCursor`. COMMIT.

Правило зачёта: `payment.currency == order.currency` (для USDT ещё `jetton_master` равен
снапшоту заказа) **и** `amount ≥ order.amount`. 1 USDT никогда не зачтётся как
1 000 000 nanoTON, хотя числа совпадают. Переплата принимается; другой отправитель
зачитывается с флагом `payer_mismatch`.

Advisory lock не нужен для корректности (инварианты выше держат и два воркера), он нужен
для экономии: два сканера удваивали бы запросы к toncenter и постоянно натыкались бы на
дубли. Lock живёт на отдельном непулированном `pg.Client`; pgbouncer в transaction-режиме
его сломает — воркер должен ходить в Postgres напрямую.

## Уведомления (outbox)

`applyPayment` создаёт строку `notifications` в той же транзакции, что и `paid`, поэтому
уведомление не может потеряться из-за падения между коммитом и отправкой. `notifyOnce`:

1. Claim одним autocommit-запросом: `UPDATE … SET claimed_at = now, attempts + 1 WHERE id IN
(SELECT … status='pending' AND next_attempt_at <= now AND (claimed_at IS NULL OR
claimed_at < now − 5 min) FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING *`.
2. `sendMessage` вне транзакции (plain text, без `parse_mode`; payload и `protect_content`
   только при `deliver_in_chat`; кнопка `https://t.me/<bot>/<app>?startapp=order_<id>`).
3. Исход: 200 → `sent`; 403 и 400 `chat not found` → `failed`; 429 → `next_attempt_at =
now + retry_after`, попытка возвращается; 5xx/сеть → `now + min(5s·2^(attempts−1), 10 мин)`,
   после 8-й неудачи → `failed`.

Гарантия at-least-once: падение между отправкой и записью исхода даёт один дубль после
5-минутного окна claim. Страница заказа в Mini App — основной канал выдачи товара.

## Возвраты

Автоматических возвратов нет. `underpaid`, `unmatched` и `ignored/unsupported_asset` видны
в ledger с адресом отправителя (для чужого jetton — ещё `source_wallet`); решение принимает
человек (этап D: attach к заказу или ручной возврат из кошелька).

## Коды выхода воркера

| Код | Причина                                                                                |
| --- | -------------------------------------------------------------------------------------- |
| 0   | штатная остановка по SIGTERM/SIGINT                                                    |
| 1   | фатальная ошибка: env, toncenter недоступен при старте, необработанный сбой            |
| 2   | предусловие: кошелёк мерчанта не `active`, пин jetton-кошелька или decimals не совпали |
| 3   | другой экземпляр держит advisory lock                                                  |
| 4   | соединение с lock потеряно во время работы                                             |

## Угроза → контроль → тест

| Угроза                                                | Контроль                                                                                     | Тест                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Повторная обработка транзакции (рестарт, re-scan)     | `UNIQUE(tx_hash)`, `ON CONFLICT DO NOTHING`                                                  | apply-payment «duplicate», scanner «second poll», rescan        |
| Два воркера обрабатывают одну транзакцию              | тот же индекс + ожидание коммита; advisory lock                                              | apply-payment «two connections», lock.test                      |
| Два платежа на один заказ                             | `FOR UPDATE` + CAS + частичный unique                                                        | apply-payment «two different transactions race»                 |
| Недоплата                                             | `amount ≥ order.amount`                                                                      | apply-payment «underpaid»                                       |
| Чужой актив (другой jetton, USDT вместо TON)          | `currency` и `jetton_master` сравниваются со снапшотом                                       | apply-payment «currency_mismatch», classify «unsupported_asset» |
| Комментарий подделан под чужой заказ                  | id — 80 случайных бит; чужой платёж всё равно оплачивает заказ, `payer_mismatch` для ревизии | apply-payment «payer mismatch»                                  |
| Нефинальная транзакция                                | `isFinal`, стоп батча                                                                        | finality.test, scanner «non-final»                              |
| Сбой посреди батча                                    | одна транзакция БД, курсор на `lastGood`, `last_error`                                       | apply-payment «rolls back», scanner «row 2 of 3»                |
| Откат курсора                                         | `GREATEST`-guard                                                                             | apply-payment «never back»                                      |
| Bounce / aborted                                      | правила classify                                                                             | classify «bounced», «aborted», live fixtures                    |
| Пропуск строки индексатором                           | `rescanRecentOnce`                                                                           | scanner «recovers a final row below the cursor»                 |
| toncenter недоступен или лимитирует                   | worker-политика retry, `last_error`, курсор на месте                                         | scanner «429», «unavailable»                                    |
| Неправильный мастер / decimals / кошелёк не задеплоен | проверки при старте, exit 2                                                                  | startup.test                                                    |
| Уведомление отправлено дважды / потеряно              | outbox в одной транзакции с `paid`, claim `SKIP LOCKED`                                      | notifier.test                                                   |
| Токен бота в логах                                    | `redactToken` во всех исходах                                                                | bot-api.test                                                    |
