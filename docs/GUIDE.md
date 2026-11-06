# Гайд: легитимные торговые боты для pump.fun

Уровни сложности от простого к продвинутому. Все боты работают на Solana mainnet
через Helius RPC и взаимодействуют с pump.fun (bonding curve) и PumpSwap (AMM после миграции).

Стратегии основаны на on-chain ресерче 666 кошельков (см. `docs/strategy-research.md`).

---

## Уровень 1: Базовый трейдер (`bots/basic-trader/`)

**Что делает:** покупает / продаёт токен по команде (CLI). Ввёл mint — купил, ввёл sell — продал.

**Архитектура:**
```
CLI → подписать tx → отправить через Helius → подтверждение
```

**Компоненты:**
- `trade.mjs` — CLI: `buy <mint> <sol>`, `sell <mint> <pct|all>`, `price <mint>`, `balance <mint>`

**Что учится:**
- Структура транзакции Solana (versioned tx, v0 messages)
- ComputeBudget: SetComputeUnitLimit + SetComputeUnitPrice
- CPI к pump.fun: аккаунты bonding curve, global, fee config
- Jito tip для приоритетной доставки

---

## Уровень 2: Монитор новых токенов (`bots/monitor/`)

**Что делает:** подписывается на логи pump.fun через WebSocket, показывает новые токены и сделки в реальном времени (V3 API).

**Архитектура:**
```
WebSocket (logsSubscribe) → парсинг V3 events + instruction names → вывод в консоль
```

**Компоненты:**
- `stream.mjs` — подключение к Helius WebSocket, фильтрация (`--filter-dev-buy <sol>`)

**Что учится:**
- WebSocket API Solana: `logsSubscribe` с фильтром по programId
- Декодирование emit_cpi событий (base64 → discriminator prefix → поля)

---

## Уровень 3: Снайпер (`bots/sniper/`)

**Стратегия из ресерча:** Slot-0 / Fast sniper (win rate 10-80% в зависимости от настроек).
Ключевое отличие от рисёрча: наш бот использует medium-speed подход (не slot-0),
что даёт больший win rate за счёт проверки dev-buy и bonding curve перед покупкой.

**Архитектура:**
```
WebSocket → BondingCurveV3 детект → проверка dev-buy → getBondingCurveState → Buy tx
                                                                                ↓
                                                                 polling цены → Sell при TP/SL/timeout
```

**Компоненты:**
- `sniper.mjs` — основной цикл: мониторинг + покупка + exit стратегия

**Параметры (ENV):**
- `SNIPER_BUY_SOL` — сколько SOL вкладывать (default: 0.1)
- `SNIPER_TAKE_PROFIT` — множитель для TP (default: 2.0x)
- `SNIPER_STOP_LOSS` — множитель для SL (default: 0.5x)
- `SNIPER_TIMEOUT_SEC` — макс. время удержания (default: 120s)
- `SNIPER_MIN_DEV_BUY` — минимальная покупка dev'а в SOL (фильтр)
- `SNIPER_MAX_POSITIONS` — макс. одновременных позиций
- `SNIPER_COOLDOWN_SEC` — пауза между покупками

---

## Уровень 4: Копи-трейдер (`bots/copy-trader/`)

**Стратегия из ресерча:** Direct High-Frequency Traders — лучший win rate (80%).
Бот следит за указанными кошельками и повторяет их сделки.

**Архитектура:**
```
WebSocket (logsSubscribe) → детект V3 TradeEvent от целевого кошелька
    → Buy если цель купила → Sell если цель продала
```

**Компоненты:**
- `watcher.mjs` — подписка и зеркалирование сделок

**Параметры (ENV):**
- `COPY_TARGETS` — адреса кошельков через запятую
- `COPY_BUY_SOL` — фиксированная сумма покупки
- `COPY_SELL_PCT` — процент от позиции при продаже
- `COPY_MAX_POSITIONS` — макс. позиций

**Кого копировать (из ресерча):**
- Direct high-freq трейдеры (без кастомных программ, CU=0)
- Sell-only кошельки с высоким PnL
- НЕ копировать: J7Tracker пользователей (стабильно убыточные)

---

## Уровень 5: Аналитический дашборд (`bots/analytics/`)

**Что делает:** собирает статистику pump.fun в реальном времени и показывает в браузере.

**Компоненты:**
- `server.mjs` — HTTP сервер + WebSocket listener
- `dashboard.html` — live дашборд (http://localhost:3000)

**Метрики:**
- Новые токены / мин
- Объём торгов (SOL)
- Buy/Sell ratio
- Top buyers по объёму
- Top tokens по объёму
- Лента последних токенов

---

## Уровень 6: Volume Analyzer (`bots/volume-analyzer/`)

**Стратегия из ресерча:** Обнаружение sell-only паттернов и multi-wallet операций.
62% win rate у sell-only кошельков — это сигнал координированных операций.

**Архитектура:**
```
getSignaturesForAddress → getTransaction → анализ:
    - wallet clustering (общие source/dest)
    - timing patterns (координированные входы)
    - program usage fingerprinting
    - sell-only detection
```

**Компоненты:**
- `analyzer.mjs` — CLI анализ кошелька или токена

**Определяет:**
- Multi-wallet операции (один оператор, несколько кошельков)
- Bundled transactions (buy+create в одном бандле)
- Coordinated exit patterns
- Wash trading indicators

---

## Уровень 7: Graduation Sniper (`bots/graduation-sniper/`)

**Стратегия:** покупает токены перед graduation (миграцией с bonding curve на PumpSwap AMM).
Graduation = bonding curve заполнена до ~85 SOL → ликвидность мигрирует на AMM.
После graduation обычно идёт pump: листинг на Jupiter, fee distribution для холдеров, FOMO.

**Архитектура:**
```
WebSocket → parse V3 TradeEvent → read reserves from event data (offset 97-129)
    → calculate fill% = virtualSol / 85 SOL
    → if fill >= 92% → BUY
    → monitor position → sell on TP/SL/timeout
```

**Компоненты:**
- `graduation.mjs` — мониторинг + покупка + exit стратегия

**Параметры (ENV):**
- `GRAD_BUY_SOL` — сумма покупки (default: 0.1)
- `GRAD_MIN_FILL_PCT` — минимальный % заполнения (default: 92)
- `GRAD_TAKE_PROFIT` — TP множитель (default: 1.5x)
- `GRAD_STOP_LOSS` — SL множитель (default: 0.7x)
- `GRAD_TIMEOUT_SEC` — таймаут позиции (default: 300s)
- `GRAD_MAX_POSITIONS` — макс. позиций (default: 3)

**Ключевое:** reserves читаются прямо из event data (offset 97-129), без дополнительных RPC вызовов.
Токен `FKJp51Mpxxsg` в dry-run тесте: обнаружен на 97.5% → вырос до 99.9% за 1 секунду.

---

## Общая инфраструктура (`lib/`)

| Модуль | Назначение |
|---|---|
| `config.mjs` | .env загрузка, slippage, CU budget, tip size |
| `constants.mjs` | Program IDs, Jito tip accounts, V3 event prefixes, instruction sets |
| `wallet.mjs` | Генерация / загрузка keypair |
| `rpc.mjs` | Connection + sendTx с retry |
| `tx.mjs` | Versioned tx сборка, ComputeBudget, Jito tip |
| `pumpfun.mjs` | BuyV2/SellV2, bonding curve state, price calc |
| `ws.mjs` | WebSocket с reconnect и подписками |

---

## Стек

- **Язык:** JavaScript (Node.js 22+, ESM)
- **Крипто:** `@solana/web3.js` v1.98 для транзакций, `@solana/spl-token` v0.4 для токенов
- **RPC:** Helius (mainnet) через HTTP + WebSocket
- **Кошелёк:** файловый keypair в `keys/` (gitignored)
- **Конфиг:** `.env` (RPC_URL, HELIUS_API_KEY)

---

## Landing Providers (из ресерча)

Для приоритетной доставки транзакций боты используют разные сервисы:

| Провайдер | Описание | Как подключить |
|---|---|---|
| Jito | MEV bundles, самый популярный | Jito tip account + sendBundle API |
| Astralane | 11 tip-адресов, 37 кошельков | SOL transfer к astr* адресам |
| Nozomi | 18 адресов, быстрый | Transfer к noz* адресам |
| HelloMoon | 8 адресов, cluster moon* | LunarLander tip |
| Helius | Priority Fee API | Через RPC с priority fee estimation |

Наш бот использует Jito (рандомный tip account из пула).

---

## Порядок реализации

1. ✅ `lib/` — общая инфра (7 модулей)
2. ✅ `bots/basic-trader/` — CLI buy/sell/price/balance
3. ✅ `bots/monitor/` — монитор новых токенов
4. ✅ `bots/sniper/` — автоматический снайпер
5. ✅ `bots/copy-trader/` — копирование сделок (per-wallet subscription)
6. ✅ `bots/analytics/` — live дашборд
7. ✅ `bots/volume-analyzer/` — анализ кошельков и стратегий
8. ✅ `bots/graduation-sniper/` — покупка перед graduation

> **V3 API (ноябрь 2026):**
> - Event prefix: `bddb7fd34ee661ee` (390-439 bytes)
> - User pubkey at offset 57 (V3 instructions), reserves at 97-129
> - Buy/sell from instruction names, NOT event bytes
> - V2 (`BuyV2`/`SellV2`) still supported but declining
> - Copy-trader subscribes per-wallet (correct for both V2/V3)
> - Graduation detected via `MigrateBondingCurveCreator` instruction
> - Fee distribution: `DistributeFeeToHolders` (high frequency)
> - PumpSwap AMM: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
