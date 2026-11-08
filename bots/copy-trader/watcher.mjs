#!/usr/bin/env node
// Copy trader: mirror target-wallet pump.fun trades.
// Buys pass the shared rug check and, unless AUTO_BUY/--auto, wait for approval.
// Open positions stop out at COPY_STOP_LOSS (default 0.94 of fill) from the trade stream.
//
//   node bots/copy-trader/watcher.mjs [--dry-run] [--auto]

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { defaultApprovalFile, listForBot } from "../../lib/approval.mjs";
import { runGuardedBuy } from "../../lib/buy-gate.mjs";
import { ROOT, SLIPPAGE_BPS } from "../../lib/config.mjs";
import {
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  SELL_INSTRUCTIONS,
} from "../../lib/constants.mjs";
import {
  DEFAULT_STOP_RATIO,
  evaluateExit,
  fillPriceSolPerToken,
  loadPositions,
  positionFile,
  savePositions,
  spotSolPerToken,
} from "../../lib/positions.mjs";
import {
  buyIx,
  calcBuyTokens,
  calcSellSol,
  getBondingCurveState,
  sellIx,
} from "../../lib/pumpfun.mjs";
import { collectChainRugSignals } from "../../lib/rugcheck-chain.mjs";
import { evaluateRug, loadThresholds } from "../../lib/rugcheck.mjs";
import { connection, sendTxWithRetry } from "../../lib/rpc.mjs";
import { approvalTtlSec, autoBuyFlag, dryRunFlag, stopRatio } from "../../lib/runtime-flags.mjs";
import { forEachTradeMark } from "../../lib/trade-event.mjs";
import { buildVersionedTx, computeBudgetIxs, jitoTipIx } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

const BUY_SOL = Number(process.env.COPY_BUY_SOL || 0.05);
const SELL_PCT = Number(process.env.COPY_SELL_PCT || 100);
const MAX_POSITIONS = Number(process.env.COPY_MAX_POSITIONS || 5);
const STOP_LOSS = stopRatio(process.env.COPY_STOP_LOSS, DEFAULT_STOP_RATIO);
const TARGETS = (process.env.COPY_TARGETS || "").split(",").map((item) => item.trim()).filter(Boolean);
const POLL_MS = 400;
const DRY_RUN = dryRunFlag();
const AUTO_BUY = autoBuyFlag();
const APPROVAL_TTL = approvalTtlSec();
const thresholds = loadThresholds();
const approvalFile = defaultApprovalFile();
const positionPath = positionFile(ROOT, "copy-trader");

let totalPnl = 0;
let totalTrades = 0;

if (!TARGETS.length) {
  console.log("Set COPY_TARGETS=addr1,addr2,... in .env");
  process.exit(1);
}

const wallet = loadKeypair();
const positions = loadPositions(positionPath);
const inflight = new Set();
const exiting = new Set();
const recentTxs = new Set();

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function persist() {
  savePositions(positionPath, positions);
}

function parseV3TradeEvent(data) {
  if (data.length < 89) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmount = Number(data.readBigUInt64LE(48)) / 1e6;
  const user = new PublicKey(data.subarray(57, 89)).toBase58();
  return { mint, solAmount, tokenAmount, user };
}

function parseTradeEvents(logs) {
  let isBuy = false, isSell = false;
  for (const line of logs) {
    const m = line.match(/Instruction: (\w+)/);
    if (!m) continue;
    if (BUY_INSTRUCTIONS.has(m[1])) isBuy = true;
    if (SELL_INSTRUCTIONS.has(m[1])) isSell = true;
  }

  const events = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const raw = Buffer.from(line.slice(14), "base64");
    if (raw.length < 8 || !raw.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    try {
      const parsed = parseV3TradeEvent(raw);
      if (!parsed) continue;
      events.push({ ...parsed, isBuy: isBuy && !isSell });
    } catch {}
  }
  return events;
}

function quoteFill(state, decimals) {
  const tokens = calcBuyTokens(state, BUY_SOL);
  return {
    tokens,
    fillPrice: fillPriceSolPerToken(BUY_SOL, tokens, decimals),
    entrySpot: spotSolPerToken(state.virtualSolReserves, state.virtualTokenReserves, decimals),
  };
}

async function paperBuy(mint, copiedFrom, decimals) {
  const state = await getBondingCurveState(new PublicKey(mint));
  if (!state || state.complete) return;
  const quote = quoteFill(state, decimals);
  positions.set(mint, {
    tokens: quote.tokens.toString(),
    fillPrice: quote.fillPrice,
    entrySpot: quote.entrySpot,
    solIn: BUY_SOL,
    entryTime: Date.now(),
    copiedFrom,
    decimals,
  });
  persist();
  log(`  [DRY RUN] tracked, fill ${quote.fillPrice.toExponential(6)} SOL/token`);
}

async function signBuy(mint, copiedFrom) {
  if (DRY_RUN) throw new Error("dry-run refused to sign");
  if (positions.has(mint)) throw new Error("position already open");
  const signals = await collectChainRugSignals({ mint });
  const rug = evaluateRug(signals, thresholds);
  if (!rug.ok) throw new Error(`rug rejected before sign: ${rug.reasons.join(" | ")}`);

  const mintPk = new PublicKey(mint);
  const state = await getBondingCurveState(mintPk);
  if (!state || state.complete) throw new Error("bonding curve unavailable");
  const decimals = signals.decimals || 6;
  const quote = quoteFill(state, decimals);
  const minTokens = (quote.tokens * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
  const ixs = [
    ...computeBudgetIxs(),
    buyIx(wallet.publicKey, mintPk, BUY_SOL, minTokens),
    jitoTipIx(wallet.publicKey),
  ];
  const tx = await buildVersionedTx(wallet, ixs);
  await sendTxWithRetry(tx, { skipPreflight: true });

  let tokens = quote.tokens;
  let fill = quote.fillPrice;
  try {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    const actual = BigInt(info.value.amount);
    if (actual > 0n) {
      tokens = actual;
      const priced = fillPriceSolPerToken(BUY_SOL, actual, decimals);
      if (priced) fill = priced;
    }
  } catch (err) {
    log(`  fill from quote, balance unread: ${err.message}`);
  }
  positions.set(mint, {
    tokens: tokens.toString(),
    fillPrice: fill,
    entrySpot: quote.entrySpot,
    solIn: BUY_SOL,
    entryTime: Date.now(),
    copiedFrom,
    decimals,
  });
  persist();
  log(`  copied, fill ${fill.toExponential(6)} SOL/token`);
}

async function copyBuy(mint, copiedFrom) {
  if (positions.size + inflight.size >= MAX_POSITIONS) return;
  if (positions.has(mint) || inflight.has(mint)) return;
  inflight.add(mint);
  try {
    log(`COPY BUY from ${copiedFrom.slice(0, 8)}...`);
    log(`  mint: ${mint.slice(0, 12)}... | ${BUY_SOL} SOL`);
    const signals = await collectChainRugSignals({ mint });
    await runGuardedBuy({
      bot: "copy-trader",
      mint,
      amountSol: BUY_SOL,
      reason: `copy buy from ${copiedFrom}`,
      dryRun: DRY_RUN,
      autoBuy: AUTO_BUY,
      signals,
      thresholds,
      approvalFile,
      ttlSec: APPROVAL_TTL,
      meta: { copiedFrom, decimals: signals.decimals || 6 },
      log,
      onPaper: () => paperBuy(mint, copiedFrom, signals.decimals || 6),
      sign: () => signBuy(mint, copiedFrom),
    });
  } catch (err) {
    log(`  copy buy failed: ${err.message}`);
  } finally {
    inflight.delete(mint);
  }
}

async function copySell(mint, copiedFrom, reason = "copy sell", pct = SELL_PCT) {
  if (exiting.has(mint)) return;
  const pos = positions.get(mint);
  if (!pos) return;
  exiting.add(mint);
  const mintPk = new PublicKey(mint);
  log(`SELL ${mint.slice(0, 8)}... (${reason}) from ${String(copiedFrom || pos.copiedFrom).slice(0, 8)}...`);
  try {
    if (DRY_RUN) {
      const state = await getBondingCurveState(mintPk);
      if (state && pos.fillPrice > 0) {
        const sellPrice = spotSolPerToken(state.virtualSolReserves, state.virtualTokenReserves, pos.decimals || 6);
        const pnlPct = ((sellPrice / pos.fillPrice) - 1) * 100;
        totalTrades++;
        log(`  [DRY RUN] would sell: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`);
      }
      positions.delete(mint);
      persist();
      return;
    }

    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    const total = BigInt(info.value.amount);
    if (total === 0n) {
      positions.delete(mint);
      persist();
      return;
    }
    const sellAmount = pct >= 100 ? total : (total * BigInt(pct)) / 100n;
    const state = await getBondingCurveState(mintPk);
    if (!state || state.complete) {
      log(`  bonding curve unavailable`);
      positions.delete(mint);
      persist();
      return;
    }
    const expectedSol = calcSellSol(state, sellAmount);
    const minSol = (expectedSol * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
    const ixs = [
      ...computeBudgetIxs(),
      sellIx(wallet.publicKey, mintPk, sellAmount, minSol),
      jitoTipIx(wallet.publicKey),
    ];
    const tx = await buildVersionedTx(wallet, ixs);
    await sendTxWithRetry(tx, { skipPreflight: true });

    const sellPrice = spotSolPerToken(state.virtualSolReserves, state.virtualTokenReserves, pos.decimals || 6);
    const pnlPct = pos.fillPrice > 0 ? ((sellPrice / pos.fillPrice) - 1) * 100 : 0;
    const pnlSol = Number(expectedSol) / 1e9 - BUY_SOL;
    totalPnl += pnlSol;
    totalTrades++;
    log(`  sold: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`);
    log(`  session: ${totalTrades} trades, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
    if (pct >= 100) {
      positions.delete(mint);
      persist();
    }
  } catch (err) {
    log(`  copy sell failed: ${err.message}`);
  } finally {
    exiting.delete(mint);
  }
}

function noteMark(mint, virtualSol, virtualToken) {
  const pos = positions.get(mint);
  if (!pos) return;
  const mark = spotSolPerToken(virtualSol, virtualToken, pos.decimals || 6);
  const decision = evaluateExit({
    mark,
    fillPrice: pos.fillPrice,
    entryTime: pos.entryTime,
    stopRatio: STOP_LOSS,
  });
  if (decision.action === "sell") copySell(mint, pos.copiedFrom, decision.reason, 100);
}

async function checkPositions() {
  for (const [mint, pos] of positions) {
    try {
      const state = await getBondingCurveState(new PublicKey(mint));
      if (!state || state.complete) continue;
      noteMark(mint, state.virtualSolReserves, state.virtualTokenReserves);
    } catch (err) {
      log(`  check error ${mint.slice(0, 8)}: ${err.message}`);
    }
  }
}

function resumeQueuedBuys() {
  if (DRY_RUN) {
    log("DRY-RUN: queued proposals are not signed");
    return;
  }
  for (const item of listForBot(approvalFile, "copy-trader", ["pending", "approved"])) {
    if (positions.has(item.mint) || inflight.has(item.mint)) continue;
    inflight.add(item.mint);
    log(`resuming proposal ${item.id} (${item.status})`);
    runGuardedBuy({
      existingId: item.id,
      bot: "copy-trader",
      mint: item.mint,
      amountSol: item.amountSol,
      reason: item.reason,
      dryRun: false,
      autoBuy: false,
      approvalFile,
      ttlSec: APPROVAL_TTL,
      log,
      sign: () => signBuy(item.mint, item.meta?.copiedFrom || "resume"),
    }).catch((err) => log(`resume ${item.id} failed: ${err.message}`))
      .finally(() => inflight.delete(item.mint));
  }
}

log("=== COPY TRADER (V3) ===");
log(`Wallet: ${wallet.publicKey.toBase58()}`);
log(`Targets: ${TARGETS.map((target) => target.slice(0, 12) + "...").join(", ")}`);
log(`Config: buy=${BUY_SOL} SOL, sell=${SELL_PCT}%, SL=${STOP_LOSS}x of fill, max=${MAX_POSITIONS}`);
log(DRY_RUN
  ? "MODE: DRY RUN (no signatures)"
  : AUTO_BUY
    ? "MODE: AUTO_BUY (signs without manual approval)"
    : `MODE: approval required (${approvalFile}, ttl ${APPROVAL_TTL}s)`);
if (positions.size) log(`Resumed ${positions.size} open position(s) from disk`);
resumeQueuedBuys();

const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;
  forEachTradeMark(value.logs, (mark) => {
    if (positions.has(mark.mint)) noteMark(mark.mint, mark.virtualSolReserves, mark.virtualTokenReserves);
  });
});

for (const target of TARGETS) {
  ws.subscribeLogs(target, async (result) => {
    const { value } = result;
    if (!value?.logs) return;
    const lastLog = value.logs[value.logs.length - 1] || "";
    if (!lastLog.includes("success")) return;
    const hasPump = value.logs.some((line) => line.includes(PUMP_PROGRAM.toBase58()));
    if (!hasPump) return;

    const sig = value.signature;
    if (recentTxs.has(sig)) return;
    recentTxs.add(sig);
    if (recentTxs.size > 10000) {
      const iter = recentTxs.values();
      for (let i = 0; i < 5000; i++) recentTxs.delete(iter.next().value);
    }

    const trades = parseTradeEvents(value.logs);
    for (const trade of trades) {
      if (trade.isBuy) await copyBuy(trade.mint, target);
      else await copySell(trade.mint, target, "target sell", SELL_PCT);
    }
  });
  log(`Subscribed to ${target.slice(0, 12)}...`);
}

setInterval(checkPositions, POLL_MS);
log("\nListening for target wallet trades...\n");

process.on("SIGINT", () => {
  log(`\nStopping.`);
  log(`  Session: ${totalTrades} trades, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
  log(`  Open positions: ${positions.size}`);
  persist();
  ws.close();
  process.exit(0);
});
