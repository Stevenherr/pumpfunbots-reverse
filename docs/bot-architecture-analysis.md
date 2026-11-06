# Архитектурный анализ ботов из on-chain данных

Дата: 2026-11-06. Источник: Solana mainnet, Helius RPC. Использовано 74 196 / 200 000 кредитов.
Выборка: 12 кошельков, 12 on-chain программ, 15 токенов (launch windows).

---

## 1. Классификация архитектур

Все наблюдаемые боты на pump.fun делятся на **два класса** по on-chain конструкции:

| Класс | Как выглядит в tx | Кол-во в выборке |
|---|---|---|
| **Router-program** | Один CPI в кастомную программу, которая сама вызывает pump.fun / PumpSwap / DEX | 5 кошельков, 6 программ |
| **Direct CPI** | Транзакция напрямую вызывает pump.fun BuyV2/SellV2 без промежуточной программы | 4 кошелька |

---

## 2. Router-программы (подробно)

### 2.1 J7Tracker (`J7pourVwqP1VtRNBiFNqbdGxwkx7ta2LHAURURRRJqmd`)

**Кошельки:** 8ZN71, Aqje5, G3fk9 (суб-кошелёк 8ZN71)
**ELF:** 437 KB, Anchor, upgradeable (auth `EhcMCmLL…`, slot 458 354 197)

**Инструкции** (из strings бинарника):
- `BuyPumpfun` — покупка на pump.fun bonding curve
- `BuyPumpDelta` — покупка с вычислением дельты
- `BuyBonk`, `BuyLaunchlabDelta` — другие площадки
- `SwapChain` — мульти-хоп свап через произвольные DEX
- `SplitSupply` — разбиение supply на до 8 адресов (basis points 1–10000)
- `Trade` — основная торговая инструкция
- `TradeWash` — wash-trade (создание видимости объёма)
- `WashWithdraw` — вывод из wash-эскроу
- `InitUserWsolAta` — инициализация WSOL-аккаунта

**Ключевые поля ошибок:**
- "Trade output below min_out" — slippage protection
- "Spend / fee side doesn't fit the route (SOL-funded vs token-funded, SOL-ending)"
- "Wash escrow account / split is malformed"
- "Wash escrow holds no SOL"

**Характеристики из данных:**
- CU price: 10 000 000 (высокий приоритет)
- Медиана удержания: 3–11 слотов (1–4 с)
- Мульти-venue: pump.fun (55%), PumpSwap (12%), Raydium CLMM, Meteora DLMM, Orca Whirlpool
- Landing: HelloMoon/LunarLander (`moon…` адреса, ~370 tips из 600 tx)
- Fee recipient: отдельный адрес на кошелёк (8XFH для 8ZN71, DXps для Aqje5)
- PnL: 8ZN71 +240 SOL, Aqje5 +75 SOL, G3fk9 +65 SOL

**Архитектура:**
```
off-chain клиент → [ComputeBudget: 10M µlamports]
                 → [J7: Trade/SwapChain]
                       ├── CPI → pump.fun BuyV2/SellV2
                       ├── CPI → PumpSwap swap
                       ├── CPI → Raydium CLMM swap_v2
                       ├── CPI → Meteora DLMM swap
                       └── CPI → Orca Whirlpool swap
                 → [SOL transfer → moon… tip]
                 → [SOL transfer → 8XFH… fee]
```

---

### 2.2 pump-stables-router (`6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB`)

**Кошелёк:** DjM7
**ELF:** 2 191 KB (самый большой), Anchor, upgradeable (auth `7gZufwwA…`, slot 454 846 926)
**Исходники:** `programs/pump-stables-router/src/`

**Инструкции** (полный список из бинарника):
- `BondingCurve` / `BondingCurveV2` / `BondingCurveV3` / `BondingCurveV3WithFee`
- `CreateCoinAndBuyBondingCurveV2` / `V3` / `JupiterBondingCurve` — создание токена + покупка в одной tx
- `PumpSwap` / `PumpSwapV2` / `PumpSwapV3` / `PumpSwapV3WithFee` / `PumpSwapJupiter`
- `SellBondingCurvePercentage` / `SellBondingCurveExactQuoteOut`
- `SellPumpSwapPercentage` / `SellPumpSwapExactQuoteOut`
- `MultiHopJupiterBuy` — мульти-хоп через Jupiter V6
- `RaydiumCpmm` / `RaydiumClmm` / `RaydiumAmm` / `RaydiumLaunchlab` (+ WithFee варианты)
- `MeteoraDbc` / `MeteoraDamm` / `MeteoraDlmm` (+ WithFee варианты)
- `CreateLimitOrder` / `ExecuteLimitOrder` / `CancelLimitOrder`

**Уникальные особенности:**
- Limit orders on-chain (эскроу + config)
- Sell по проценту (`sell_bps 1–10000`) или по точной сумме выхода (`exact_quote_out`)
- Референтная система (`fee_referral`, `fee_referrer`, `fee_referrer_vault`)
- `pump_agent_payments_program` — интеграция с pump.fun агентами
- Jupiter CPI для произвольного маршрута (`jupiter_cpi.rs`)
- Поддержка USD1 / USDC через стабл-бриджи (Raydium CLMM stable route)
- Fee program отдельный (`fee_program`, `fee_treasury`, `fee_event_authority`)

**Характеристики из данных:**
- CU price: 10 000 (низкий — не конкурирует за приоритет, а оптимизирует расход)
- Медиана удержания: 59 слотов (~24 с)
- Медиана покупки: 0.111 SOL (маленькие позиции, много токенов)
- Мульти-venue: pump.fun (59%), other (35%), PumpSwap (4%), Jupiter V6 (1%)
- Fee recipient: KfHb
- PnL: +133 SOL

**Вспомогательные программы DjM7:**
- `Exw9h2Dt…` (88 KB) — `conditional-buy-guard`: файлы `routed.rs`, `migrated.rs` — предохранитель при покупке (проверяет условия перед исполнением)
- `DALbqcC7…` (21 KB) — минимальная программа, подписант транзакций `5J6MBBA8…`

---

### 2.3 FLASHX (`FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9`)

**Кошельки:** 8ZN71, G3fk9 (используется параллельно с J7)
**ELF:** 193 KB, upgradeable (auth `AxDepcBg…`, slot 464 982 228)

**Обработчики** (из `core/src/handlers/`):
- pump: `pump.rs`, `pump_amm.rs`, `pump_amm_multi_creator.rs`, `pump_amm_flexible_creator.rs`, `pump_v2_wrapped_buy_exact_in.rs` и ещё 4 варианта pump
- DEX: `clmm_swap_v2.rs`, `meteora_amm.rs`, `meteora_amm_v2.rs`, `meteora_dlmm_family.rs`, `orca.rs`, `raydium_cpmm.rs`, `raydium_clmm_legacy.rs`, `raydium_v4.rs`
- Другие: `boop.rs`, `bordrless.rs`, `heaven.rs`, `humidifi.rs`, `launchlab.rs`, `liquidaf_*.rs`, `metadao.rs`, `moonshot.rs`, `poseidon.rs`
- `pump_multi_hop.rs` — мульти-хоп через pump

**Вывод:** универсальный свап-роутер, поддерживающий ~20 DEX-площадок. Отдельная программа от J7, но используется теми же кошельками.

---

### 2.4 HAQQ Router (`haqqqMGN35ehCftXca3KWxJFXTBcWTWeNHNtUHLGQdh`)

**Кошелёк:** haqq6qnV
**ELF:** 66 KB, upgradeable (auth `HAQQshph…`, slot 463 885 980)
**Исходники:** `programs/haqq-router/src/instructions/trade.rs`

**Характеристики:**
- CU price: ~2 000 000
- Медиана удержания: 8 слотов (~3 с) — один из самых быстрых
- 150 из 150 tx используют эту программу
- Venues: pump.fun (87%), PumpSwap (13%)
- Landing: Jito (основной)
- PnL: +1.7 SOL

Компактный роутер, специализированный на pump.fun + PumpSwap.

---

### 2.5 FAdo Router (`FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe`)

**Кошелёк:** AwwWhCek
**ELF:** 155 KB, upgradeable (auth `83CpBne2…`, slot 416 108 084 — самый старый деплой)

**Характеристики:**
- CU price: ~2 940 000
- Медиана удержания: **837 слотов (~335 с)** — самый долгий в выборке
- Venues: pump.fun (82%), other (16%), Jupiter V6 (1%), PumpSwap (2%)
- Landing: приватные адреса (`7FeFBYbe…`, `A7hAgCzF…`, `62qc2CNX…`)
- Также использует Jupiter V6 и программу `DF1ow4ts…` и `CLEANALo…`
- PnL: +0.1 SOL (почти нулевой)

Стратегия: долгое удержание, маленькие позиции (0.068 SOL медиана). Не снайпер, а position trader.

---

### 2.6 fxckso1g4z (`fxckso1g4zPGWcoAtsgKsatficCCPSHAL1bWFMvSSzA`)

**ELF:** 806 KB, upgradeable (auth `vampeehdD3…`, slot 458 788 013)
**Исходники:** `src/conditional/meteora/wide.rs`, `src/conditional/raydium_clmm.rs`, `src/conditional/orca.rs`, `src/conditional/meteora_dlmm.rs`, `src/conditional/meteora_dbc.rs`, `src/math/token.rs`

Conditional execution engine: on-chain проверки условий перед свапом. Поддерживает Meteora (wide, exact, DBC), Raydium CLMM, Orca. Не привязана к конкретному кошельку в нашей выборке, но загружена как связанная программа.

---

### 2.7 L2TExMFKdjpN (Lighthouse)

**ELF:** 424 KB, **immutable** (auth = None)
**Инструкции:** AssertAccountData, AssertTokenAccount, AssertStakeAccount, AssertUpgradeableLoaderAccount, AssertSysvarClock, AssertMerkleTreeAccount

On-chain assertion framework. Проверяет состояние аккаунтов и данных после транзакции. Используется кошельком `abcdEvo…`. Подходит для верификации: "после свапа на моём аккаунте должно быть >= N токенов, иначе revert".

---

## 3. Боты без кастомной программы (Direct CPI)

| Кошелёк | CU price | Hold (сек) | Buy median | PnL | Landing |
|---|---|---|---|---|---|
| 8PgC4… | 2 000 000 | ~15 | 0.96 SOL | +6.4 | SpeedLanding, Astralane |
| 9pQQc… | 1 500 001 | ~12 | 0.70 SOL | +1.9 | Astralane (100%) |
| 3qvuM… | 1 824 817 | ~13 | 0.33 SOL | -1.6 | Jito |
| ssssswdk… | 1 887 843 | ~40 | 0.31 SOL | -1.4 | Jito |

Особенности:
- Вызывают `pump.fun BuyV2/SellV2` напрямую из top-level instructions
- Нет промежуточного роутера — вся логика off-chain
- CU price 1.5–2M (типичный для снайперов, но ниже чем J7)
- Не мульти-venue: 97–100% pump.fun
- Разнообразие tip-провайдеров: одни используют только Astralane, другие только Jito

---

## 4. Провайдеры доставки транзакций (landing services)

По данным tip-переводов из всех кошельков:

| Провайдер | Адреса (префиксы) | % от всех tips | Кошельки |
|---|---|---|---|
| **HelloMoon / LunarLander** | `moon…` (12+ адресов) | ~35% | 8ZN71, Aqje5, G3fk9 |
| **8XFH / DXps / KfHb** (fee recipients) | `8XFH…`, `DXps…`, `KfHb…` | ~30% | 8ZN71, Aqje5, DjM7 |
| **Jito** | `wyvP…`, `5VY9…`, `3KCK…`, `9bnz…`, `2q5p…`, `CsJL…` | ~15% | 3qvuM, ssssswdk, EMKY7, haqq6 |
| **Astralane** | `astra…` | ~10% | 9pQQc (100% Astralane), EMKY7 |
| **SpeedLanding** | `SPeE…`, `SpEe…` | ~3% | 8PgC4 |
| **Helius Sender** | `4ACf…` | ~2% | 3qvuM, abcdE |
| **Nozomi** | `nozG…` | <1% | CvoHw (XTbot) |
| **Private/Unknown** | `7FeF…`, `A7hA…`, `62qc…` | ~5% | AwwWhCek |

Замечание: `8XFH`, `DXps`, `KfHb` — это не landing-сервисы, а fee-адреса самих ботов (1.3% от продаж), т.е. плата за использование роутера.

---

## 5. Compute Budget паттерны

| Группа | CU price | CU limit | Интерпретация |
|---|---|---|---|
| J7Tracker | 10 000 000 | 500–2000 | Максимальный приоритет, минимальный лимит (знают точный расход) |
| pump-stables-router | 10 000 | 310 000–400 000 | Низкий приоритет, большой лимит (сложные мульти-хоп транзакции) |
| HAQQ | ~2 000 000 | ~60 000 | Средний приоритет |
| Direct CPI | 1 500 000–2 000 000 | 50 000–80 000 | Стандартный снайпер |
| FAdo | ~2 940 000 | ~170 000 | Высокий приоритет, большой лимит |

J7Tracker ставит CU limit ~500, потому что программа точно считает расход (каждый лишний CU ≈ деньги при таком cu_price). Direct CPI ставят ~60K — запас на случай вариаций.

---

## 6. On-chain программы: сводная таблица

| Программа | Размер | Anchor | Upgradeable | Venue-охват | Инструкции |
|---|---|---|---|---|---|
| J7pourVwq… | 437 KB | Да | Да | 5+ DEX | Trade, SwapChain, SplitSupply, TradeWash |
| 6Vo3245es… | 2191 KB | Да | Да | 7+ DEX + Jupiter | BondingCurve*, PumpSwap*, MultiHop, LimitOrder |
| FLASHX8Dr… | 193 KB | Нет | Да | 20+ DEX | Handlers для каждого DEX |
| haqqqMGN3… | 66 KB | Нет | Да | 2 (pump+PumpSwap) | trade |
| FAdo9NCw1… | 155 KB | ? | Да | 3+ DEX + Jupiter | ? |
| Exw9h2Dt6… | 88 KB | ? | Да | pump.fun | conditional-buy-guard |
| fxckso1g4… | 806 KB | Нет | Да | 5 DEX | conditional math |
| L2TExMFKd… | 424 KB | Нет | **Нет** | — | Assert* (верификация) |

---

## 7. Наблюдаемые паттерны

### 7.1 Время удержания vs. PnL
```
Кошелёк       Hold(с)   PnL(SOL)   Стратегия
8ZN71         ~3        +240       Ultra-fast scalp (launch & dump)
G3fk9         ~11       +65        Fast scalp (суб 8ZN71)
haqq6         ~3        +1.7       Ultra-fast, маленькие позиции
Aqje5         ~6        +75        Fast scalp
3qvuM         ~13       -1.6       Средняя скорость, убыточный
9pQQc         ~12       +1.9       Средняя скорость
DjM7          ~24       +134       Медленнее, но крупнее
AwwWhCek      ~335      +0.1       Position (5 мин), ~безубыток
ssssswdk      ~40       -1.4       Медленный, убыточный
```

Вывод: самые прибыльные — самые быстрые (3–6 с). Но они же используют кастомные роутеры.

### 7.2 Buy/Sell ratio
- 8ZN71: 75 buy / 290 sell — **продаёт в 4 раза чаще** (дробление продаж)
- DjM7: 44 buy / 79 sell — продаёт в 2 раза чаще
- haqq6: 72 buy / 78 sell — примерно равно
- Direct CPI боты: ~1:1

Дробление продаж — признак стратегии постепенного выхода.

### 7.3 Мульти-venue routing
Router-боты (J7, pump-stables-router, FLASHX) торгуют на 5–20 площадках. Direct CPI боты — почти исключительно на pump.fun. Это значит:
- Router-боты следят за токеном после миграции с bonding curve на AMM
- Direct CPI боты работают только на bonding curve фазе

---

## 8. Программы: язык и фреймворк

Все программы написаны на **Rust** и скомпилированы для Solana BPF:
- **J7Tracker** и **pump-stables-router**: используют **Anchor** (есть IDL-инструкции, constraint messages)
- **FLASHX**: не Anchor (нет IDL-инструкций), вероятно native Solana program или pinocchio
- **HAQQ**: минимальный роутер, вероятно native
- **L2TExMFKdjpN**: immutable assertion framework, native

Off-chain часть невозможно определить из on-chain данных. Языки клиента могут быть: TypeScript (solana/web3.js), Rust (solana-sdk), Python (solders), Go, C++ — это не видно в транзакциях.

---

## 9. Что ещё можно извлечь из имеющихся данных

Скрипты в `research/` позволяют:

| Вопрос | Команда |
|---|---|
| Профиль нового кошелька | `node research/fetch.mjs 5000 400 <addr>` → `python3 research/analyze.py <addr>` |
| Кто заработал на конкретном запуске | `python3 research/victims.py data/windows.json` |
| Бинарник и metadata программы | `node research/programs.mjs <programId>` |
| Роль адреса в транзакциях | `python3 research/roles.py <addr>` |
| Дамп конкретной tx | `python3 research/inspect_tx.py <sig>` |

Для расширения выборки нужно:
1. Скачать транзакции новых кошельков (`fetch.mjs`)
2. Запустить `analyze.py` с `--json`
3. Для launch-window анализа: добавить записи в `windows.json` и запустить `fetch_window.mjs` + `victims.py`

Остаток бюджета: 125 804 кредитов.
