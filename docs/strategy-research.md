# Стратегии ботов на pump.fun: on-chain исследование

Анализ 666 уникальных кошельков, 1314 транзакций из launch-окон 15 токенов.

---

## 1. Классификация стратегий

### 1.1 Slot-0 Bundled Snipers
**10 кошельков | Win rate: 10% | Total PnL: -6.50 SOL**

Покупают в том же слоте, что и CreateV2. Используют экстремальный CU price (до 200M microlamports).
Обычно связаны с Jito bundle — транзакция включается в бандл вместе с CreateV2.

| Кошелёк | PnL | CU Price | Тип |
|---|---|---|---|
| D5BDDk… | +0.12 | 200,000,000 | direct + TemporalDAO tips |
| E5n4Zy… | -0.00 | 10,000,000 | direct |
| 7LqfdK… | -0.01 | 5,000,000 | L2TExMFKdjpN router |

**Паттерн:** BUY в slot+0 → SELL через 1-2 секунды. CU price 150M+ на buy, 10M на sell.
**Вывод:** Крайне рискованная стратегия. Высокие комиссии за приоритет, большинство теряют деньги.

---

### 1.2 Direct High-Frequency Traders
**5 кошельков | Win rate: 80% | Total PnL: +1.26 SOL**

Лучшая стратегия по win rate. Торгуют без кастомных программ, CU price = 0.
Приоритет получают через Jito bundles или landing providers.

| Кошелёк | Buys | Sells | PnL | Mints |
|---|---|---|---|---|
| EMKY7r… | 6 | 8 | +0.87 | 6 |
| ERwFAL… | 1 | 2 | +0.21 | 1 |
| BLw4fX… | 1 | 2 | +0.20 | 1 |

**Паттерн:** Множество сделок в минуту, быстрый вход/выход, маленькие позиции.
**Вывод:** Самая эффективная стратегия для ретейл-трейдеров.

---

### 1.3 Router Program Bots
**344 кошелька | Win rate: 38% | Total PnL: -69.14 SOL**

Самая популярная категория. Используют кастомные on-chain программы для маршрутизации сделок.

**Top программы:**
| Программа | Транзакций | Кошельков | Тип |
|---|---|---|---|
| FLASHX8DrLbg… | 279 | 190 | Агрегатор, 20+ DEX |
| 6Vo3245eszAb… | 116 | 91 | Router (неизвестный) |
| L2TExMFKdjpN… | 61 | 41 | Proxy/router |
| GMgnVFR8Jb39… | 34 | 27 | GMGN.ai frontend |
| term9YPb9mzA… | 32 | 25 | Terminus (limit orders) |

**Вывод:** Массовое использование, но низкий win rate. Программы дают удобство, но не преимущество в скорости.

---

### 1.4 Multi-Op Custom Bots (single-user programs)
**123 кошелька | Win rate: 32% | Total PnL: -57.89 SOL**

Кастомные программы, используемые одним или несколькими кошельками.

| Кошелёк | Программа | Buys | Sells | PnL |
|---|---|---|---|---|
| kurtzsJg… | ZEPHYRrtq7Hi (custom) | 12 | 12 | +0.62 |
| 8nbxQNb1… | 6ptPant1trvN (custom) | 7 | 7 | +1.70 |
| Eh7fDUAg… | D3gA5pMG + L2TExMFK | 3 | 3 | +1.17 |
| HK9K6ZMM… | rNFuTz3Vkk21 (custom) | 3 | 3 | +1.15 |

**Паттерн ZEPHYR:** 24 транзакции через собственную программу, свой tip-адрес ZEPHEE8EaJ, 5 токенов.
Все 20 последних транзакций — ошибки. Стратегия brute-force: спамить транзакциями, ~5% приземляются.

**Паттерн 6ptPant1:** Deployer — кошелёк загружает/обновляет собственные BPF-программы.
Самый прибыльный среди medium-speed (+1.70 SOL).

**Вывод:** Кастомные программы — high-effort, mixed results. Успех зависит от логики, не от наличия программы.

---

### 1.5 Sell-Only (Pre-loaded Positions)
**26 кошельков | Win rate: 62% | Total PnL: +7.88 SOL**

Только продажи в окне наблюдения. Токены были куплены до нашего окна (через bundles, другие кошельки, или airdrop).

| Кошелёк | PnL | Slot offset | Метод |
|---|---|---|---|
| D7EJXU… | +2.49 | 18039 | direct, высокий CU |
| AnHnjf… | +2.12 | 1704 | direct |
| 3iawEZ… | +0.94 | 644 | direct |

**Паттерн:** Покупка через отдельный кошелёк (bundle), продажа через основной — разделение buy/sell identity.
**Вывод:** Указывает на sophisticated операции с множеством кошельков.

---

### 1.6 Jupiter Arbitrage
**32 кошелька | Win rate: 41% | Total PnL: -0.89 SOL**

Маршрутизация через Jupiter V6 для cross-DEX арбитража.

| Кошелёк | PnL | Slot offset | Направление |
|---|---|---|---|
| 6T8uWu… | +0.64 | 20532 | sell-only |
| 4uATtZ… | +0.36 | 5728 | buy+sell |
| 4buM6H… | +0.08 | 357847 | sell-only |

**Паттерн:** Большинство — sell-only. Покупают на pump.fun (bonding curve), продают через Jupiter (лучший rate после миграции на PumpSwap/Raydium).
**Вывод:** Реальная арбитражная стратегия, но с маленькой маржой.

---

### 1.7 Buy-Only (Diamond Hands / Exit Elsewhere)
**55 кошельков | Win rate: 0% | Total PnL: -31.26 SOL**

Только покупки в нашем окне, нет продаж.

**Варианты:**
- Holding (diamond hands)
- Продажа через другой DEX (Jupiter, Raydium)
- Продажа через другой кошелёк
- Рагнутые позиции

---

## 2. Landing Providers (сервисы доставки транзакций)

| Провайдер | Tips | Кошельков | Адресов | Как определить |
|---|---|---|---|---|
| KfHbT5Jr… (неизвестный) | 116 | 91 | 1 | Самый популярный единый адрес |
| Jito MEV | 115 | 54 | 1 | Известный Jito tip account |
| Astralane | 68 | 37 | 11 | Префикс astr*/Astr* |
| Nozomi | 53 | 24 | 18 | Префикс noz*/Noz* |
| MoonLander/HelloMoon | 31 | 6 | 8 | Префикс moon* |
| TemporalDAO | 20 | 8 | 2 | TEMP*/ENxT* |
| GMGN.ai | 16 | 13 | 9 | Префикс gmgn* |
| LandX | 14 | 5 | 4 | Префикс Land* |
| Stellar | 6 | 6 | 4 | Префикс ste11* |
| SpeedLanding | 5 | 3 | 3 | Sp1x*/SpEE* |
| Falcon | - | - | 4 | Fa1c* |

**Вывод:** Рынок landing providers фрагментирован. Jito и Astralane — лидеры, но десятки других провайдеров конкурируют.

---

## 3. Ключевые выводы

### Win Rate по стратегиям
```
Direct High-Freq:  ████████████████████  80%
Sell-Only:         ████████████████      62%
Jupiter Arb:       ██████████            41%
Router Program:    ████████              38%
Multi-Op Bot:      ███████               32%
Slot-0 Sniper:     ██                    10%
Buy-Only:                                 0%
```

### Trader Persistence
- **571 из 666** кошельков (85%) торгуют только 1 токен в нашем окне
- Repeat traders: максимум 8 токенов
- J7pourVwqP1VtRNB (J7Tracker) — самые частые repeat traders, но все с отрицательным PnL

### Боты (реализованные)

1. ✅ **Basic Trader** — CLI buy/sell
2. ✅ **Monitor** — отслеживание новых токенов (V3 API)
3. ✅ **Sniper** — fast buy + TP/SL/timeout exit
4. ✅ **Copy Trader** — копирование high-freq трейдеров (per-wallet WS subscription)
5. ✅ **Volume Analyzer** — sell-only паттерны, multi-wallet операции
6. ✅ **Analytics Dashboard** — live статистика на port 3000
7. ✅ **Graduation Sniper** — покупка перед graduation (~85 SOL fill)

### Новые стратегии (V3 ресерч, ноябрь 2026)

**8. Fee Income Strategy (НЕ реализовано)**
- pump.fun V3 добавил `DistributeFeeToHolders` — холдеры токена получают часть торговых комиссий
- Частота: ~147 из 500 транзакций — очень высокая
- Стратегия: покупать токены с высоким объёмом торгов, держать для пассивного дохода
- Аналог: дивидендная стратегия на акциях

**9. PumpSwap AMM Trading (НЕ реализовано)**
- PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) — AMM для graduated токенов
- Инструкции: `Buy` (disc `66063d1201daebea`), `Sell` (disc `33e685a4017f83ad`)
- Trade event: `67f4521f2cf57777` (508 bytes)
- Стратегия: торговля graduated токенами с высокой ликвидностью
- Нужно: decode account layout для PumpSwap swap instructions

**10. Jito Bundle Backrun (НЕ реализовано)**
- Backrun create-транзакции: обнаружить create в мемпуле, отправить buy-бандл сразу после
- API: Jito Block Engine `sendBundle` JSON-RPC
- Библиотеки: `jito-ts`, `@jito-labs/jito-ts`, `sol.js`
- Latency: gRPC быстрее HTTP для bundle submission
- Самая прибыльная стратегия, но сложная в реализации

**11. Multi-Hop Arbitrage (НЕ реализовано)**
- `MultiHopSwap`, `MultiHopCurveSwap`, `MultiHopJupiterBuy/Sell` — арбитраж через bonding curve + AMM
- Если токен торгуется и на bonding curve, и на PumpSwap — возможен price gap
- Нужно: мониторинг цен на обоих venues одновременно

### V3 API: новые инструкции (из live анализа 500 txs)

```
Trading:    Buy(92), Sell(109), BuyExactQuoteInV3(64), SellV3(60),
            BuyV2(19), SellV2(28), BuyExactQuoteInV2(39), BuyV3(13)
Create:     BondingCurveV3(44), BondingCurveJupiter(5)
Fees:       DistributeFeeToHolders(147), GetFeesWithQuoteMint(179),
            CollectCoinCreatorFee(5), SweepCreatorFee(3)
Migration:  MigrateBondingCurveCreator(2)
Volume:     PumpBondingCurveBuyWithVolumeV2(3), InitUserVolumeAccumulator(1)
Multi-hop:  MultiHopSwap(15), MultiHopCurveSwap(9),
            MultiHopJupiterBuy(8), MultiHopJupiterSell(5)
PumpSwap:   Swap(18), SwapV2(16), SwapV3(4)
```
