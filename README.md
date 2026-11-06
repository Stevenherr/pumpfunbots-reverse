# pumpfunbots-reverse

**Open-source toolkit for analyzing and trading pump.fun memecoins on Solana.**

Built from on-chain research of 666 wallets, 7 strategy types, and 10+ landing providers. Fully updated for pump.fun V3 API (November 2026).

---

## What's Inside

```
                    YOU
                     |
              lib/ (shared infra)
                     |
   +--------+--------+--------+--------+--------+--------+
   |        |        |        |        |        |        |
 BASIC   MONITOR  SNIPER   COPY    ANALYTICS  VOLUME  GRADUATION
TRADER            BOT    TRADER   DASHBOARD  ANALYZER  SNIPER
```

### Bots

| Bot | What it does | File |
|-----|-------------|------|
| **Basic Trader** | CLI buy/sell/price/balance on bonding curve | `bots/basic-trader/trade.mjs` |
| **Monitor** | Real-time stream of new tokens + trades via WebSocket | `bots/monitor/stream.mjs` |
| **Sniper** | Auto-buy on new token creation, exit on TP/SL/timeout | `bots/sniper/sniper.mjs` |
| **Copy Trader** | Mirror trades from target wallets in real-time | `bots/copy-trader/watcher.mjs` |
| **Analytics** | Live dashboard at localhost:3000 with volume, top buyers, charts | `bots/analytics/server.mjs` |
| **Volume Analyzer** | CLI tool to classify wallet strategies and detect patterns | `bots/volume-analyzer/analyzer.mjs` |
| **Graduation Sniper** | Detects tokens about to graduate to PumpSwap AMM | `bots/graduation-sniper/graduation.mjs` |

### Shared Library (`lib/`)

| Module | Purpose |
|--------|---------|
| `config.mjs` | Loads `.env`, slippage, CU budget, tip size |
| `constants.mjs` | Program IDs, V3 event prefixes, instruction sets |
| `pumpfun.mjs` | Bonding curve math, buy/sell instructions |
| `rpc.mjs` | Connection + sendTx with retry |
| `tx.mjs` | Versioned tx builder, ComputeBudget, Jito tip |
| `wallet.mjs` | Keypair generation and loading |
| `ws.mjs` | WebSocket with auto-reconnect |

### Research

| File | Content |
|------|---------|
| `docs/strategy-research.md` | 7 strategy classifications, win rates, PnL data |
| `docs/wallet-analysis.md` | Deep analysis of on-chain wallet behaviors |
| `docs/GUIDE.md` | Full guide from beginner to advanced |

---

## Quick Start

```bash
# Install
npm install

# Set up
cp .env.example .env
# Edit .env with your Helius RPC URL

# Generate a wallet
node -e "import('./lib/wallet.mjs').then(m => m.generateKeypair())"

# Run the monitor
node bots/monitor/stream.mjs

# Run the sniper (dry-run, no real trades)
node bots/sniper/sniper.mjs --dry-run

# Run the dashboard
node bots/analytics/server.mjs
# Open http://localhost:3000
```

---

## Key Discovery: pump.fun V3 Migration

During development we discovered pump.fun silently migrated to V3 API:

| | V2 (old) | V3 (current) |
|--|---------|-------------|
| Trade event prefix | `e445a52e51cb9a1d` | `bddb7fd34ee661ee` |
| Create instruction | `CreateV2` | `BondingCurveV3` |
| Buy/sell detection | `is_buy` byte in event | Instruction name in logs |
| Event size | 113 bytes | 390-391 bytes |
| New features | — | Cashback, holder fees, volume tracking |

All bots in this repo are V3-compatible.

---

## Strategy Research Summary

From analyzing 666 wallets across 7 strategy types:

| Strategy | Wallets | Win Rate | Key Signal |
|----------|---------|----------|------------|
| Direct High-Freq | 89 | **80%** | No custom programs, CU=0 |
| Sell-Only | 112 | 62% | Only sells, coordinated ops |
| Slot-0 Sniper | 67 | 10-45% | Buys in same slot as create |
| Custom Bot | 203 | 35% | Custom program CPI |
| Multi-Program | 45 | 40% | Multiple programs per tx |
| Brute Force | 98 | 25% | High volume, low selectivity |
| Buy-Only | 52 | 15% | Never sells (honeypot test?) |

---

## Stack

- **Runtime:** Node.js 22+ (ESM)
- **Chain:** Solana mainnet via Helius RPC
- **Programs:** pump.fun `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- **Dependencies:** `@solana/web3.js`, `@solana/spl-token`, `bs58`

---

## Disclaimer

This is research and educational software. Trading memecoins carries extreme risk. Use at your own risk. Start with `--dry-run` and paper trading.

---

Built with on-chain research. No paid indicators. No subscriptions. Just code.
