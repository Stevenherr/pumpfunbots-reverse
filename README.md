<p align="center">
  <img src="docs/banner.svg" alt="pumpfunbots-reverse" width="100%">
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/node-%3E%3D22-00ff88?style=flat-square&logo=node.js&logoColor=white" alt="Node 22+"></a>
  <a href="#stack"><img src="https://img.shields.io/badge/solana-mainnet-7c3aed?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiPjxjaXJjbGUgY3g9IjEwIiBjeT0iMTAiIHI9IjgiIGZpbGw9IiM3YzNhZWQiLz48L3N2Zz4=&logoColor=white" alt="Solana"></a>
  <a href="#v3-migration"><img src="https://img.shields.io/badge/pump.fun-V3%20API-00d4ff?style=flat-square" alt="V3 API"></a>
  <a href="#strategy-research"><img src="https://img.shields.io/badge/wallets-666%20analyzed-f85149?style=flat-square" alt="666 wallets"></a>
  <a href="#bots"><img src="https://img.shields.io/badge/bots-7%20ready-e3b341?style=flat-square" alt="7 bots"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b949e?style=flat-square" alt="MIT"></a>
</p>

<p align="center">
  <code>on-chain intelligence toolkit for pump.fun</code>
</p>

---

<img src="docs/bots.svg" alt="Bot Arsenal" width="100%">

---

## Quick Start

```bash
git clone https://github.com/zostaff/pumpfunbots-reverse.git
cd pumpfunbots-reverse
npm install
cp .env.example .env          # add your Helius API key
```

```bash
# generate a trading wallet
node -e "import('./lib/wallet.mjs').then(m => m.generateKeypair())"

# monitor new tokens in real-time
node bots/monitor/stream.mjs

# sniper bot (paper trading)
node bots/sniper/sniper.mjs --dry-run

# live analytics dashboard
node bots/analytics/server.mjs    # open localhost:3000
```

---

## V3 Migration

> pump.fun silently migrated to V3. Every existing bot using old prefixes is dead. We decoded the new format.

```
                        V2 (DEAD)                    V3 (LIVE)
 ──────────────────────────────────────────────────────────────
  Trade event        e445a52e51cb9a1d            bddb7fd34ee661ee
  Event size         113 bytes                   390-391 bytes
  Buy/sell           is_buy byte                 Instruction name
  Create             CreateV2 event              BondingCurveV3
  User pubkey        offset 57                   offset 57 (verified)
  Reserves           not in event                offset 97-113
  New features       -                           cashback, holder fees
 ──────────────────────────────────────────────────────────────
```

<details>
<summary><b>V3 Event Layout (click to expand)</b></summary>

```
Offset   Size   Field
───────────────────────────────────────
0        8      Discriminator (bddb7fd34ee661ee)
8        32     Mint (Pubkey)
40       8      SOL amount (u64 lamports)
48       8      Token amount (u64)
57       32     User (Pubkey)
97       8      Virtual SOL reserves (u64)
105      8      Virtual token reserves (u64)
113+     278    Extended data
```

Buy/sell determined from instruction names in tx logs:
```
BUY:    Buy, BuyV2, BuyV3, BuyExactQuoteInV2, BuyExactQuoteInV3, BuyExactSolIn
SELL:   Sell, SellV2, SellV3
CREATE: BondingCurveV3, BondingCurveJupiter
```

</details>

---

## Strategy Research

```
 666 wallets analyzed across 7 strategy types
 ──────────────────────────────────────────────────────────────

  Direct High-Freq    ██████████████████████████████████████  80%   89 wallets
  Sell-Only           █████████████████████████               62%  112 wallets
  Slot-0 Sniper       ██████████████████                      45%   67 wallets
  Multi-Program       ████████████████                        40%   45 wallets
  Custom Bot          ██████████████                          35%  203 wallets
  Brute Force         ██████████                              25%   98 wallets
  Buy-Only            ██████                                  15%   52 wallets
```

<details>
<summary><b>Strategy Details</b></summary>

| Strategy | How it works | Key signal |
|----------|-------------|------------|
| **Direct High-Freq** | Standard instructions, CU=0, pure selection edge | No custom programs |
| **Sell-Only** | Never buys on pump.fun, receives via bundles/airdrops | Coordinated ops |
| **Slot-0 Sniper** | Buys same slot as token creation | Latency game |
| **Custom Bot** | Deploys own program, calls pump.fun via CPI | Custom program ID |
| **Multi-Program** | Multiple programs per tx (buy + tip + routing) | Complex tx layout |
| **Brute Force** | High volume, low selectivity, needs 4x+ winners | Spray and pray |
| **Buy-Only** | Never sells on pump.fun (AMM exit or honeypot test) | One-directional |

</details>

---

## Bots

| | Bot | What it does | Run |
|-|-----|-------------|-----|
| `01` | **Basic Trader** | CLI buy/sell/price/balance | `node bots/basic-trader/trade.mjs buy <mint> 0.1` |
| `02` | **Monitor** | Real-time token + trade stream | `node bots/monitor/stream.mjs` |
| `03` | **Sniper** | Auto-buy on creation, TP/SL exit | `node bots/sniper/sniper.mjs --dry-run` |
| `04` | **Copy Trader** | Mirror target wallet trades | `node bots/copy-trader/watcher.mjs --dry-run` |
| `05` | **Analytics** | Live dashboard at :3000 | `node bots/analytics/server.mjs` |
| `06` | **Volume Analyzer** | Wallet/token strategy classifier | `node bots/volume-analyzer/analyzer.mjs wallet <addr>` |
| `07` | **Graduation Sniper** | Buy before PumpSwap migration | `node bots/graduation-sniper/graduation.mjs --dry-run` |

<details>
<summary><b>Shared Library (lib/)</b></summary>

| Module | Purpose |
|--------|---------|
| `config.mjs` | `.env` loader, slippage (5%), CU budget, tip size |
| `constants.mjs` | Program IDs, V3 event prefixes, instruction sets |
| `pumpfun.mjs` | Bonding curve PDA, state deserialization, buy/sell ix |
| `rpc.mjs` | Connection + sendTx with retry + confirmation |
| `tx.mjs` | Versioned tx builder, ComputeBudget, Jito tip |
| `wallet.mjs` | Keypair load/generate from `keys/` |
| `ws.mjs` | WebSocket with auto-reconnect |

</details>

---

## Sniper Results (dry-run)

```
[12:18:22] SNIPING: DYdfB51GxXj1SydBJm8uJbndgPBTs8dYwZEg6yF6pump
  buying 0.1 SOL -> ~7,235,110 tokens
  entry: 0.000013566412 SOL/tok
  [DRY RUN] position tracked

[12:18:25] SELL (take-profit 1.9x)
  +88.2%, held 3 seconds
  session: 1 trade, 1W/0L

  45 seconds total: 3 trades, 2W/1L, 66% win rate
```

---

## PumpSwap AMM

> When a bonding curve fills (~85 SOL), the token graduates to PumpSwap AMM.

```
 PumpSwap is 1.8x busier than bonding curve
 ──────────────────────────────────────────

  Events/sec      318 (vs 180 bonding curve)
  Volume          ~660,000 SOL/min
  Bot trades      43% under 0.01 SOL
  Whale trades    8.4% over 10 SOL

  Trade prefix    67f4521f2cf57777  (497 bytes)
  Fee prefix      3e2f370aa503dc2a  (449 bytes)
  Program         pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
```

---

## Landing Providers

> Speed infrastructure identified from tip transfer patterns.

| Provider | Addresses | Notes |
|----------|-----------|-------|
| **Jito** | 8 accounts | Dominant. MEV bundles. |
| **Astralane** | 11 (astr* prefix) | Growing fast |
| **Nozomi** | 18 (noz* prefix) | Speed-focused |
| **MoonLander** | 8 (moon* prefix) | Mid-tier |
| **GMGN.ai** | 9 (gmgn* prefix) | Consumer bots |

Our bots use Jito tips with random account selection.

---

## Stack

```
Runtime         Node.js 22+ (ESM)
Chain           Solana mainnet via Helius RPC
Programs        pump.fun    6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
                PumpSwap    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
Dependencies    @solana/web3.js  @solana/spl-token  bs58
                (3 packages. no frameworks. no build tools.)
```

---

## Research

| File | Content |
|------|---------|
| [`docs/strategy-research.md`](docs/strategy-research.md) | 7 strategy classifications, win rates, PnL |
| [`docs/wallet-analysis.md`](docs/wallet-analysis.md) | Deep on-chain wallet behavior analysis |
| [`docs/article.md`](docs/article.md) | Full writeup of the reverse engineering process |
| [`docs/GUIDE.md`](docs/GUIDE.md) | Complete guide from beginner to advanced |

---

<p align="center">
  <sub>A research tool, not a promise of returns. Start with <code>--dry-run</code>.</sub>
</p>

<p align="center">
  <sub>Built from raw on-chain data. No paid signals. No black boxes. Just code.</sub>
</p>
