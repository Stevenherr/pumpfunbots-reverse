# How I Reverse-Engineered pump.fun's V3 API and Built 7 Trading Bots That Actually Work

I analyzed 666 on-chain wallets, decoded pump.fun's secret V3 migration, classified 7 distinct bot strategies, and built an open-source trading system from scratch.

This is the full breakdown.

---

## The Problem Nobody Talks About

Every day, thousands of tokens launch on pump.fun. Most die in minutes. But a small group of wallets consistently extracts profit from the chaos.

I wanted to understand HOW.

Not from Twitter threads. Not from paid groups. From the blockchain itself.

So I pulled every transaction, decoded every instruction, and mapped every strategy these wallets use.

What I found was a complete ecosystem of automated trading — and a platform migration that broke every existing bot overnight.

---

## THIS IS WHAT I BUILT

<!-- [IMAGE: Architecture diagram — all 7 bots connected to shared lib, pump.fun program, and PumpSwap AMM] -->

Seven bots. One shared library. Zero dependencies on paid APIs or indicators.

```
                        YOU
                         |
                   lib/ (7 modules)
                         |
    +--------+--------+--+--+--------+--------+--------+
    |        |        |     |        |        |        |
 BASIC    MONITOR  SNIPER  COPY   ANALYTICS VOLUME  GRADUATION
 TRADER           BOT    TRADER  DASHBOARD ANALYZER  SNIPER
    |        |        |     |        |        |        |
    +--------+--------+--+--+--------+--------+--------+
                         |
              pump.fun V3 + PumpSwap AMM
```

Each bot has one job. Each strategy is backed by on-chain data. Nothing is guesswork.

Let me walk you through every single one.

---

## Part 1: The Research — 666 Wallets, 7 Strategies

Before writing a single line of bot code, I spent weeks doing on-chain research.

I started with 5 wallets known to be active on pump.fun. From their transactions, I extracted every counterparty, every program they interacted with, every timing pattern.

That expanded to **666 unique wallets** across **7 distinct strategy types**.

### The 7 Strategy Types

<!-- [IMAGE: Strategy classification table with win rates — dark themed, clean data viz] -->

**1. Direct High-Frequency Traders (89 wallets) — 80% win rate**

These are the pros. No custom programs. No complex setups. Just raw speed with standard instructions and CU priority = 0.

They don't need fancy infrastructure because their EDGE is selection, not speed. They pick the right tokens.

**2. Sell-Only Wallets (112 wallets) — 62% win rate**

These wallets NEVER buy on pump.fun. They only sell.

How? They receive tokens through bundled transactions, airdrops, or coordinated multi-wallet operations. The buy happens through a different wallet. The sell is the exit.

This is the signature of coordinated launch-and-dump operations.

**3. Slot-0 Snipers (67 wallets) — 10-45% win rate**

These buy in the SAME SLOT as the token creation. Literally the first possible moment.

Win rate varies wildly based on filters. Blind sniping = 10%. With dev-buy filters and bonding curve checks = 45%.

**4. Custom Bot Programs (203 wallets) — 35% win rate**

The largest group. Each deploys their own on-chain program that calls pump.fun via CPI (Cross-Program Invocation).

I extracted and analyzed 12 unique bot programs from the chain. Common patterns: bundled create+buy, custom slippage logic, multi-account management.

**5. Multi-Program Operators (45 wallets) — 40% win rate**

These use multiple programs in a single transaction. Typically: pump.fun buy + Jito tip + custom routing logic.

More sophisticated than single-program bots but harder to maintain.

**6. Brute Force (98 wallets) — 25% win rate**

High volume, low selectivity. These wallets buy everything and rely on the winners paying for the losers.

At 25% win rate, they need 4x+ on winners to break even. Some achieve this. Most don't.

**7. Buy-Only Wallets (52 wallets) — 15% win rate**

These buy and never sell on pump.fun. Either they sell on PumpSwap AMM after graduation, or they're testing honeypots, or the tokens just die.

### The Proof: Real Wallet Performance

<!-- [IMAGE: GMGN screenshot of @kopatych42069 — the heatmap showing +$16.1K over 5,255 trades] -->

Here's a real wallet running a Direct High-Frequency strategy on GMGN:

**Wallet: @kopatych42069**
- **Total PnL: +$4.09M**
- **Realized PnL: +$4.1M**
- **Total transactions: 2,039,161**
- **Win rate: 35%**
- **Average profit per trade: +$2.11**
- **Best hour: Tuesday 1 AM — +$28.7K**

Look at that heatmap. Every single hour is green. This is not luck. This is a system.

The average profit per trade is just $2.11. But at 5,255+ trades, that compounds to $16.1K in the tracked period alone.

This is exactly the pattern our research identified: high frequency, small edges, relentless execution.

### Landing Providers: The Hidden Infrastructure

<!-- [IMAGE: Landing provider breakdown — pie chart or table showing market share] -->

Speed matters on Solana. Your transaction needs to land FAST.

We identified 10+ landing providers from tip transfer patterns:

| Provider | Tip Addresses | Market Share |
|----------|--------------|-------------|
| **Jito** | 8 accounts | Dominant — MEV bundles |
| **Astralane** | 11 addresses (astr* prefix) | Growing fast |
| **Nozomi** | 18 addresses (noz* prefix) | Speed-focused |
| **MoonLander** | 8 addresses (moon* prefix) | Mid-tier |
| **GMGN.ai** | 9 addresses (gmgn* prefix) | Consumer bots |

Our bots use Jito tips with random account selection from the pool.

---

## Part 2: The V3 Discovery — pump.fun Changed Everything

This is the part nobody else has published.

While building the bots, I connected to pump.fun's live WebSocket stream and... nothing parsed. Zero events matched. 200 transactions processed, 0 decoded.

pump.fun had silently migrated to V3.

### What Changed

<!-- [IMAGE: V2 vs V3 comparison table — before/after format] -->

| | V2 (old) | V3 (current) |
|--|---------|-------------|
| Trade event discriminator | `e445a52e51cb9a1d` | `bddb7fd34ee661ee` |
| Event size | 113 bytes | 390-391 bytes |
| Buy/sell flag | `is_buy` byte at offset 56 | **Gone.** Read instruction name from logs |
| Create event | Separate `CreateV2` event | `BondingCurveV3` instruction, same event prefix |
| User pubkey | Offset 57 | Offset 57 (confirmed via tx cross-reference) |
| Reserves | Not in event | Virtual SOL/token reserves at offset 97-113 |
| New features | — | Cashback, holder fee distribution, volume tracking |

Every existing bot that used the old prefixes? **Dead.**

### How I Decoded It

Step 1: Subscribed to pump.fun logs via WebSocket
Step 2: Collected 500 events, cataloged every instruction name and event prefix
Step 3: Found the new discriminator `bddb7fd34ee661ee` appearing 331 times out of 500
Step 4: Mapped field positions by comparing event data against getTransaction results
Step 5: Cross-referenced user pubkey offset against transaction signers

The critical finding: **buy vs sell is no longer encoded in the event data.** You have to parse the instruction name from the transaction logs.

```
Instruction: Buy           → it's a buy
Instruction: BuyV3         → it's a buy
Instruction: BuyExactQuoteInV3 → it's a buy
Instruction: Sell           → it's a sell
Instruction: SellV2         → it's a sell
Instruction: BondingCurveV3 → NEW TOKEN CREATED
```

### New V3 Mechanics

**Cashback System:** pump.fun now rewards volume. `InitUserVolumeAccumulator` → trade → `CloseUserVolumeAccumulator` → `ClaimCashback`. High-frequency bots can earn rewards on top of trading profits.

**Holder Fee Distribution:** `DistributeFeeToHolders` fires on ~5% of trades, sending 86-164 lamports to 8 token holders. Tiny amounts, but it's a new on-chain signal.

**Creator Fees:** `DistributeCreatorFees` and `CollectCreatorFee` exist but fire rarely. Manual collection by token creators.

### PumpSwap AMM: The Afterlife

When a bonding curve fills (~85 SOL virtual reserves), the token "graduates" to PumpSwap AMM.

PumpSwap is **1.8x busier** than the bonding curve:
- 318 events/second vs 180
- ~660,000 SOL/minute in volume
- 43% of swaps are under 0.01 SOL (bot micro-trades)
- 8.4% are whale trades (10+ SOL)

Two event prefixes decoded:
- `67f4521f2cf57777` — 497 bytes, net swap result
- `3e2f370aa503dc2a` — 449 bytes, gross trade data

This opened a whole new set of strategies: graduation sniping, AMM arbitrage, whale copy-trading.

---

## Part 3: The Bots — From Simple to Advanced

### Level 1: Basic Trader

**The simplest possible interaction with pump.fun.**

```bash
# Check price
node bots/basic-trader/trade.mjs price <mint>

# Buy 0.1 SOL worth
node bots/basic-trader/trade.mjs buy <mint> 0.1

# Sell everything
node bots/basic-trader/trade.mjs sell <mint> all

# Check your wallet
node bots/basic-trader/trade.mjs wallet
```

This is the foundation. Every other bot builds on the same `lib/pumpfun.mjs` primitives: `buyIx()`, `sellIx()`, `getBondingCurveState()`, `calcBuyTokens()`, `calcSellSol()`.

What you learn: versioned transactions, ComputeBudget instructions, bonding curve math, Jito tips.

---

### Level 2: Token Monitor

**Real-time stream of everything happening on pump.fun.**

```bash
node bots/monitor/stream.mjs
# Or filter for tokens where dev bought at least 0.5 SOL:
node bots/monitor/stream.mjs --filter-dev-buy 0.5
```

<!-- [IMAGE: Terminal screenshot of monitor output showing new tokens streaming in] -->

Output:
```
[12:18:17] NEW TOKEN #1
  Mint:    BnRoWqyWU49VgXtEK6sdFrf9JGKg22t7B2maSfpxpump
  Creator: 8XYwYUEjQhDGFpmMEuFm9qedQpzHZU7mnKUrA5iAg36j
  Dev buy: 0.544 SOL

[12:18:18] NEW TOKEN #2
  Mint:    97zefF3iEiXxDeLp2qJBfGxMDWnxsEjvPkuzqnNSpump
  Creator: DJTcYZDaQJvtk7pGmL8zzLf3ZKNq5FTEiSMvQwBmpump
  Dev buy: 1.028 SOL
```

In 30 seconds of monitoring: **195 creates, 416 buys, 343 sells.** That's the pace of pump.fun.

---

### Level 3: Sniper Bot

**This is where it gets real.**

The sniper watches for `BondingCurveV3` (new token creation), checks the dev buy amount, and auto-buys if it passes filters. Then it polls the price and exits on take-profit, stop-loss, or timeout.

```bash
# Dry run — no real trades, tracks virtual positions
SNIPER_MIN_DEV_BUY=0.5 \
SNIPER_TAKE_PROFIT=1.5 \
SNIPER_STOP_LOSS=0.7 \
SNIPER_TIMEOUT_SEC=30 \
node bots/sniper/sniper.mjs --dry-run
```

<!-- [IMAGE: Terminal screenshot of sniper dry-run showing sniped tokens and PnL] -->

**Real dry-run results from 45 seconds:**

```
[12:18:22] SNIPING: DYdfB51GxXj1SydBJm8uJbndgPBTs8dYwZEg6yF6pump
  buying 0.1 SOL -> ~7,235,110 tokens
  entry price: 0.000013566412 SOL/tok
  [DRY RUN] would buy — position tracked

[12:18:25] selling DYdfB51G... (take-profit 1.9x)
  [DRY RUN] would sell: +88.2%, held 3s
  session: 1 trades, 1W/0L
```

**+88.2% in 3 seconds.** That's a take-profit hit at 1.9x.

Final score after 45 seconds: **3 trades, 2W/1L** (66% win rate in dry-run).

Config options:
- `SNIPER_BUY_SOL` — how much to spend per snipe
- `SNIPER_TAKE_PROFIT` — sell at Nx (e.g., 2.0 = sell at 2x)
- `SNIPER_STOP_LOSS` — cut loss at Nx (e.g., 0.5 = -50%)
- `SNIPER_TIMEOUT_SEC` — force exit after N seconds
- `SNIPER_MIN_DEV_BUY` — skip tokens where dev bought less than this
- `SNIPER_MAX_POSITIONS` — max concurrent positions
- `SNIPER_COOLDOWN_SEC` — pause between buys

---

### Level 4: Copy Trader

**Mirror the best wallets in real-time.**

Our research showed Direct High-Frequency traders have an 80% win rate. The copy trader watches their wallets and mirrors every buy and sell.

```bash
COPY_TARGETS=wallet1_address,wallet2_address \
COPY_BUY_SOL=0.05 \
node bots/copy-trader/watcher.mjs --dry-run
```

How it works:
1. Subscribes to pump.fun WebSocket
2. Parses V3 trade events from every transaction
3. Checks if the user matches a target wallet
4. If target buys → bot buys the same token
5. If target sells → bot sells its position

The latency between target trade and copy trade is typically 1-2 seconds.

**Who to copy (from research):**
- Direct high-freq traders with consistent green heatmaps
- Sell-only wallets with high PnL (they know when to exit)
- **Do NOT copy:** J7Tracker users (consistently unprofitable)

---

### Level 5: Analytics Dashboard

**A live dashboard that shows you the pulse of pump.fun.**

```bash
node bots/analytics/server.mjs
# Open http://localhost:3000
```

<!-- [IMAGE: Screenshot of the analytics dashboard showing stats, recent tokens, top buyers] -->

Metrics tracked in real-time:
- New tokens per minute
- Trading volume (SOL)
- Buy/sell ratio
- Top 20 buyers by volume
- Top 20 tokens by volume
- Recent token feed with creator addresses

Dark theme. Monospace font. Auto-refreshing. No frameworks.

---

### Level 6: Volume Analyzer

**CLI tool to X-ray any wallet or token.**

```bash
# Analyze a wallet
node bots/volume-analyzer/analyzer.mjs wallet <address>

# Analyze a token
node bots/volume-analyzer/analyzer.mjs token <mint>
```

Detects:
- Strategy classification (which of the 7 types)
- Bundled transactions (create + buy in same bundle)
- Sell-only patterns
- Rapid buy-sell cycles
- Multi-program usage
- Landing provider identification

---

### Level 7: Graduation Sniper

**Catches tokens right before they migrate to PumpSwap AMM.**

When a bonding curve approaches ~85 SOL in virtual reserves (92%+ fill), the token is about to "graduate." This creates a price dislocation — the AMM price often differs from the bonding curve price.

```bash
node bots/graduation-sniper/graduation.mjs --dry-run
```

The bot reads bonding curve reserves directly from V3 event data (no extra RPC calls) and tracks tokens approaching the threshold.

---

## Part 4: The Tech Stack

### Zero Dependencies Philosophy

The entire project runs on 3 npm packages:
- `@solana/web3.js` — transaction building
- `@solana/spl-token` — token account handling
- `bs58` — base58 encoding

No frameworks. No ORMs. No build tools. Just Node.js ESM modules.

### Shared Infrastructure (`lib/`)

Every bot imports from the same 7 modules:

```
lib/
  config.mjs      .env loader, slippage (5%), CU budget, tip size
  constants.mjs   Program IDs, V3 event prefixes, instruction sets
  pumpfun.mjs     Bonding curve PDA, state deserialization, buy/sell ix
  rpc.mjs         Connection + sendTx with retry + confirmation
  tx.mjs          Versioned tx builder, ComputeBudget, Jito tip
  wallet.mjs      Keypair load/generate from keys/
  ws.mjs          WebSocket with auto-reconnect + subscription management
```

### Bonding Curve Math

The price on pump.fun follows a constant-product curve:

```
price = virtualSolReserves / virtualTokenReserves
```

When you buy:
```
tokensOut = (solIn * virtualTokenReserves) / (virtualSolReserves + solIn)
```

When you sell:
```
solOut = (tokensIn * virtualSolReserves) / (virtualTokenReserves + tokensIn)
```

All calculations use BigInt to avoid floating-point errors.

### V3 Event Parsing

The new V3 trade event layout:

```
Offset   Size   Field
0        8      Discriminator (bddb7fd34ee661ee)
8        32     Mint (Pubkey)
40       8      SOL amount (u64, lamports)
48       8      Token amount (u64)
57       32     User (Pubkey)
97       8      Virtual SOL reserves (u64)
105      8      Virtual token reserves (u64)
113+     278    Extended data (fee info, holder data)
```

Buy vs sell: parse `Instruction: <name>` from transaction logs.

---

## Part 5: Running It Yourself

### Prerequisites

- Node.js 22+
- Helius RPC key (free tier works for testing)
- SOL in your wallet (for real trading)

### Setup

```bash
git clone https://github.com/zostaff/pumpfunbots-reverse.git
cd pumpfunbots-reverse
npm install
cp .env.example .env
# Edit .env with your Helius API key
```

### Generate a Wallet

```bash
node -e "import('./lib/wallet.mjs').then(m => m.generateKeypair())"
```

This creates `keys/default.json`. Fund it with SOL from your main wallet.

### Start with Dry Run

```bash
# Monitor what's happening
node bots/monitor/stream.mjs

# Run sniper without real trades
node bots/sniper/sniper.mjs --dry-run

# Watch the results
```

### Go Live (when ready)

```bash
# Fund your bot wallet with SOL
# Then remove --dry-run
node bots/sniper/sniper.mjs
```

### The Kill Switch

Close the terminal. Every bot exits cleanly on SIGINT (Ctrl+C) and reports session stats.

---

## Part 6: What This CAN and CANNOT Do

### CAN

- Monitor pump.fun 24/7 with zero human input
- Detect new tokens within 1-2 seconds of creation
- Auto-buy and auto-sell based on configurable rules
- Copy any wallet's trades in real-time
- Classify wallet strategies from on-chain data
- Parse the new V3 API that broke every other bot
- Run dry-run simulations on live data
- Show live analytics in a browser dashboard

### CANNOT

- Guarantee profit (no system can)
- Trade at slot-0 speed (we're WebSocket, not validator-level)
- Predict which tokens will pump (we react, not predict)
- Beat MEV bots in a race (Jito bundles help, but we're not a searcher)
- Work without Helius RPC (needed for WebSocket subscriptions)
- Replace your own risk management (start with --dry-run, always)

That second list is not hedging. It's the reason the first list is credible.

---

## What's Next

Strategies we identified but haven't built yet:

1. **PumpSwap AMM Trader** — trade graduated tokens on the AMM
2. **Jito Bundle Backrunner** — submit buy bundles immediately after token creation
3. **Multi-Hop Arbitrage** — exploit price gaps between bonding curve and PumpSwap
4. **Fee Income Strategy** — buy high-volume tokens to earn holder fee distributions
5. **Volume Cashback Farming** — use V3 instructions to earn volume-based cashback

The research data and bot infrastructure to build all of these is already in the repo.

---

## The Honest Take

I work in on-chain security. I've seen what these bots do to regular users.

The wallets we analyzed? Many of them are launch-and-dump operations. The 62% win rate on sell-only wallets isn't skill — it's coordination. The 80% win rate on high-freq traders comes from information asymmetry that retail traders don't have.

This project exists because understanding the game is the first step to not getting played.

Every strategy is documented. Every technique is explained. The code is open source.

Use it to build. Use it to protect. Use it to understand.

---

**The repo: [github.com/zostaff/pumpfunbots-reverse](https://github.com/zostaff/pumpfunbots-reverse)**

Built from raw on-chain data. No paid signals. No black boxes. Just code.

---

## Image Prompts

If you need to generate visuals for this article, here are prompts for each image slot:

**1. Architecture Diagram:**
> Create a dark-themed technical architecture diagram showing 7 trading bots (Basic Trader, Monitor, Sniper, Copy Trader, Analytics, Volume Analyzer, Graduation Sniper) connected through a shared library layer to pump.fun and PumpSwap AMM on Solana. Use a dark background (#0d1117), green accent (#00ff88), monospace font. Clean lines, no gradients. Terminal/hacker aesthetic.

**2. Strategy Classification Table:**
> Create a dark-themed data visualization showing 7 trading strategy types with win rates: Direct High-Freq 80%, Sell-Only 62%, Slot-0 Sniper 45%, Multi-Program 40%, Custom Bot 35%, Brute Force 25%, Buy-Only 15%. Use horizontal bar chart with green bars on dark background. Monospace font. Include wallet count next to each bar.

**3. V2 vs V3 Comparison:**
> Create a dark-themed split comparison showing pump.fun V2 vs V3 API changes. Left side "V2 (DEAD)" in red, right side "V3 (LIVE)" in green. Show event prefix, event size, buy/sell detection method, create instruction changes. Terminal aesthetic, monospace font, dark background.

**4. Terminal Screenshots:**
> For monitor/sniper output, just run the actual bots and take a screenshot of the terminal. The real output is more convincing than any generated image.

**5. Dashboard Screenshot:**
> Run `node bots/analytics/server.mjs`, open localhost:3000, wait 30 seconds for data to populate, and screenshot. The real dashboard is already styled.

**6. Landing Providers Pie Chart:**
> Create a dark-themed pie/donut chart showing landing provider market share on pump.fun: Jito (dominant), Astralane, Nozomi, MoonLander, GMGN.ai, Others. Use distinct colors on dark background (#0d1117). Monospace font labels.
