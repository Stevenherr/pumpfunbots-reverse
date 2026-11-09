#!/usr/bin/env node
// Sniper: buy a new pump.fun token on BondingCurveV3, exit on take-profit / stop-loss / timeout.
//
//   node bots/sniper/sniper.mjs [--dry-run] [--auto]
//
// --dry-run never signs. Without --auto / AUTO_BUY=1 a live buy waits for approval.
// Stop-loss defaults to 0.94 (-6%) of the fill price and is checked on the trade stream.

import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { defaultApprovalFile, listForBot } from "../../lib/approval.mjs";
import { runGuardedBuy } from "../../lib/buy-gate.mjs";
import { attachBotStatus } from "../../lib/bot-status.mjs";
import { historyFile, noteLaunch, noteRug } from "../../lib/creator-history.mjs";
import { compactSkipKey, confirmEntry, loadEntryConfig, thresholdsForLiquidity } from "../../lib/entry-confirm.mjs";
import { loadExitConfig, planExit } from "../../lib/exit-plan.mjs";
import { sizeBuy } from "../../lib/sizing.mjs";
import { appendTrade, tradeLogFile } from "../../lib/trade-log.mjs";
import { loadMintBlock, saveMintBlock } from "../../lib/graduation-entry.mjs";
import { claimHold, heldByOther, heldMintsFile, releaseHold } from "../../lib/held-mints.mjs";
import { ROOT, SLIPPAGE_BPS } from "../../lib/config.mjs";
import {
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  CREATE_INSTRUCTIONS,
  SELL_INSTRUCTIONS,
} from "../../lib/constants.mjs";
import {
  DEFAULT_STOP_RATIO,
  earlyStopMargin,
  effectiveStopRatio,
  staleExitMark,
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
  expectedSellPrice,
  exitImpactOfBuy,
  getBondingCurveState,
  sellIx,
} from "../../lib/pumpfun.mjs";
import { collectChainRugSignals } from "../../lib/rugcheck-chain.mjs";
import { evaluateRug, loadThresholds } from "../../lib/rugcheck.mjs";
import { connection, sendTxWithRetry } from "../../lib/rpc.mjs";
import { positionPollMs } from "../../lib/rpc-budget.mjs";
import { createRetryQueue } from "../../lib/retry-queue.mjs";
import { freshLaunchDecision, nextHeldMint } from "../../lib/sniper-entry.mjs";
import { approvalTtlSec, autoBuyFlag, dryRunFlag, stopRatio } from "../../lib/runtime-flags.mjs";
import { forEachTradeMark } from "../../lib/trade-event.mjs";
import { buildVersionedTx, computeBudgetIxs, jitoTipIx } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

const BUY_SOL = Number(process.env.SNIPER_BUY_SOL || 0.1);
const TAKE_PROFIT = Number(process.env.SNIPER_TAKE_PROFIT || 2.0);
const STOP_LOSS = stopRatio(process.env.SNIPER_STOP_LOSS, DEFAULT_STOP_RATIO);
const TIMEOUT_SEC = Number(process.env.SNIPER_TIMEOUT_SEC || 120);
const MAX_POSITIONS = Number(process.env.SNIPER_MAX_POSITIONS || 3);
const MIN_DEV_BUY = Number(process.env.SNIPER_MIN_DEV_BUY || 0);
const COOLDOWN_SEC = Number(process.env.SNIPER_COOLDOWN_SEC || 10);
const TOKEN_COOLDOWN_SEC = Number(process.env.SNIPER_TOKEN_COOLDOWN_SEC || 600);
const MAX_CURVE_SOL = Number(process.env.SNIPER_MAX_CURVE_SOL || 12);
const MIN_CURVE_SOL = Number(process.env.SNIPER_MIN_CURVE_SOL || 2);
const MAX_EXIT_IMPACT_PCT = Number(process.env.MAX_EXIT_IMPACT_PCT || 5);
const MIN_BUY_SOL = Number(process.env.MIN_BUY_SOL || 0.02);
const MAX_BUY_OF_REAL_PCT = Number(process.env.MAX_BUY_OF_REAL_PCT || 5);
const exitConfig = loadExitConfig();
const entryConfig = loadEntryConfig();
const tradesPath = tradeLogFile(ROOT);
const NO_REENTRY = !["0", "false", "no", "off"].includes(String(process.env.SNIPER_NO_REENTRY_AFTER_STOP ?? "1").toLowerCase());
const STOP_TRIGGER = effectiveStopRatio(STOP_LOSS, earlyStopMargin());
const POLL_MS = positionPollMs();
const DRY_RUN = dryRunFlag();
const AUTO_BUY = autoBuyFlag();
const APPROVAL_TTL = approvalTtlSec();
const thresholds = loadThresholds();
const approvalFile = defaultApprovalFile();
const positionPath = positionFile(ROOT, "sniper");
const creatorPath = historyFile(ROOT);
const blockPath = path.join(ROOT, "data", "sniper-block.json");
const holdPath = heldMintsFile(ROOT);
const block = loadMintBlock(blockPath);
const retries = createRetryQueue({ maxAttempts: 3 });
const mintSubs = new Map();
const noted = new Set();
const pending = new Map();
let pollCursor = 0;
let ws;

let totalPnl = 0;
let totalTrades = 0;
let wins = 0;

const wallet = loadKeypair();
const positions = loadPositions(positionPath);
const inflight = new Set();
const exiting = new Set();
let lastBuyTime = 0;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function exitKind(reason) {
  const text = String(reason);
  if (text.startsWith("stop-loss")) return "stop_loss";
  if (text.startsWith("partial-tp")) return "partial_take_profit";
  if (text.startsWith("trail-stop")) return "trailing_stop";
  if (text.startsWith("take-profit")) return "take_profit";
  if (text.startsWith("timeout")) return "timeout";
  return text.split(" ")[0] || "exit";
}

function sizedReason(sol) {
  return Math.abs(sol - BUY_SOL) < 1e-9 ? "size_max" : "size_scaled";
}

function journal(row) {
  try {
    appendTrade(tradesPath, row);
  } catch (err) {
    log(`  trade log: ${err.message}`);
  }
}

function persist() {
  savePositions(positionPath, positions);
}

function slotsUsed() {
  return positions.size + inflight.size;
}

function parseV3TradeEvent(data) {
  if (data.length < 89) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmountRaw = data.readBigUInt64LE(48);
  const tokenAmount = Number(tokenAmountRaw) / 1e6;
  const user = new PublicKey(data.subarray(57, 89)).toBase58();
  let virtualSolReserves, virtualTokenReserves, realSolReserves;
  if (data.length >= 113) {
    virtualSolReserves = data.readBigUInt64LE(97);
    virtualTokenReserves = data.readBigUInt64LE(105);
  }
  if (data.length >= 121) realSolReserves = data.readBigUInt64LE(113);
  return { mint, solAmount, tokenAmount, tokenAmountRaw, user, virtualSolReserves, virtualTokenReserves, realSolReserves };
}

function parseLogEvents(logs) {
  let isBuy = false, isCreate = false, isSell = false;
  for (const line of logs) {
    const m = line.match(/Instruction: (\w+)/);
    if (!m) continue;
    if (BUY_INSTRUCTIONS.has(m[1])) isBuy = true;
    if (SELL_INSTRUCTIONS.has(m[1])) isSell = true;
    if (CREATE_INSTRUCTIONS.has(m[1])) isCreate = true;
  }

  const events = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const raw = Buffer.from(line.slice(14), "base64");
    if (raw.length < 8 || !raw.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;

    try {
      const parsed = parseV3TradeEvent(raw);
      if (!parsed) continue;
      if (isCreate) events.push({ type: "create", creator: parsed.user, ...parsed });
      if (isBuy || isSell) events.push({ type: "trade", isBuy: isBuy && !isSell, ...parsed });
    } catch {}
  }
  return events;
}

function quoteFill(state, decimals, solIn = BUY_SOL) {
  const tokens = calcBuyTokens(state, solIn);
  return {
    tokens,
    solIn,
    fillPrice: fillPriceSolPerToken(solIn, tokens, decimals),
    entrySpot: spotSolPerToken(state.virtualSolReserves, state.virtualTokenReserves, decimals),
  };
}

function persistBlock() {
  saveMintBlock(blockPath, block);
}

function sessionLine() {
  const sign = totalPnl >= 0 ? "+" : "";
  return `session: ${totalTrades} trades, ${wins}W/${totalTrades - wins}L, PnL: ${sign}${totalPnl.toFixed(4)} SOL`;
}

function remember(mint, pos) {
  positions.set(mint, pos);
  block.seen.add(mint);
  persist();
  persistBlock();
  watchMint(mint);
}

function finishMint(mint, reason) {
  block.seen.add(mint);
  block.cooldown.set(mint, Date.now() + TOKEN_COOLDOWN_SEC * 1000);
  if (NO_REENTRY && String(reason).startsWith("stop-loss")) block.stopped.add(mint);
  persistBlock();
  releaseHold(holdPath, "sniper", mint);
  unwatchMint(mint);
}

async function paperBuy(mint, context) {
  const state = context.curve || await getBondingCurveState(new PublicKey(mint));
  if (!state || state.complete) {
    log(`  skip: bonding curve unavailable`);
    return;
  }
  const solIn = Number(context.solIn) > 0 ? Number(context.solIn) : BUY_SOL;
  const quote = quoteFill(state, context.decimals || 6, solIn);
  remember(mint, {
    tokens: quote.tokens.toString(),
    fillPrice: quote.fillPrice,
    entrySpot: quote.entrySpot,
    solIn,
    remainingFrac: 1,
    partialDone: false,
    peakRatio: 1,
    entryLiquiditySol: context.entryLiquiditySol ?? null,
    filters: context.filters || [],
    entryTime: Date.now(),
    decimals: context.decimals || 6,
    creator: context.creator || null,
  });
  log(`  [DRY RUN] would buy — position tracked, fill ${quote.fillPrice.toExponential(6)} SOL/token`);
}

async function signBuy(mint, context = {}) {
  if (DRY_RUN) throw new Error("dry-run refused to sign");
  if (positions.has(mint)) throw new Error("position already open");

  const devBuyTokensRaw = context.devBuyTokensRaw == null ? null : BigInt(context.devBuyTokensRaw);
  const signals = await collectChainRugSignals({
    mint,
    creator: context.creator || null,
    devBuyTokensRaw,
    creatorLaunches: context.creatorLaunches ?? null,
    creatorRugs: context.creatorRugs ?? null,
    realSol: context.curve?.realSolReserves == null ? null : Number(context.curve.realSolReserves) / 1e9,
  });
  const rug = evaluateRug(signals, thresholds);
  if (rug.deferred) throw new Error(`rate limited before sign: ${rug.reasons.join(" | ")}`);
  if (!rug.ok) throw new Error(`rug rejected before sign: ${rug.reasons.join(" | ")}`);

  const mintPk = new PublicKey(mint);
  const state = await getBondingCurveState(mintPk);
  if (!state || state.complete) throw new Error("bonding curve unavailable");

  const decimals = signals.decimals || context.decimals || 6;
  const solIn = Number(context.solIn) > 0 ? Number(context.solIn) : BUY_SOL;
  const quote = quoteFill(state, decimals, solIn);
  const minTokens = (quote.tokens * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
  log(`  buying ${solIn} SOL -> ~${(Number(quote.tokens) / 10 ** decimals).toFixed(0)} tokens`);

  const ixs = [
    ...computeBudgetIxs(),
    buyIx(wallet.publicKey, mintPk, solIn, minTokens),
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
      const priced = fillPriceSolPerToken(solIn, actual, decimals);
      if (priced) fill = priced;
    }
  } catch (err) {
    log(`  fill from quote, balance unread: ${err.message}`);
  }
  remember(mint, {
    tokens: tokens.toString(),
    fillPrice: fill,
    entrySpot: quote.entrySpot,
    solIn,
    remainingFrac: 1,
    partialDone: false,
    peakRatio: 1,
    entryLiquiditySol: context.entryLiquiditySol ?? null,
    filters: context.filters || [],
    entryTime: Date.now(),
    decimals,
    creator: context.creator || null,
  });
  log(`  position opened, fill ${fill.toExponential(6)} SOL/token`);
}

function curveFromTrade(trade) {
  if (!trade?.virtualSolReserves || !trade?.virtualTokenReserves) return null;
  return {
    virtualSolReserves: trade.virtualSolReserves,
    virtualTokenReserves: trade.virtualTokenReserves,
    realSolReserves: trade.realSolReserves,
    complete: false,
  };
}

function realSolOf(trade) {
  if (trade?.realSolReserves == null) return null;
  return Number(trade.realSolReserves) / 1e9;
}

async function considerCreate(create, devTrade, opts = {}) {
  const trade = devTrade || create;
  const realSol = realSolOf(trade);
  const gate = freshLaunchDecision({
    isCreate: true,
    realSol,
    maxRealSol: MAX_CURVE_SOL,
    seen: block.seen.has(create.mint),
    stopped: NO_REENTRY && block.stopped.has(create.mint),
    cooldownUntil: block.cooldown.get(create.mint) || 0,
    now: Date.now(),
    heldByOther: Boolean(heldByOther(holdPath, "sniper", create.mint)),
  });
  if (!opts.fromRetry && gate.action !== "buy") {
    if (gate.reason.startsWith("curve_not_fresh") || gate.reason === "curve_unknown") block.seen.add(create.mint);
    if (gate.reason !== "not_create" && !noted.has(`${create.mint}:${gate.reason}`)) {
      noted.add(`${create.mint}:${gate.reason}`);
      log(`skip ${create.mint.slice(0, 8)}: ${gate.reason}`);
      persistBlock();
    }
    return;
  }
  if (realSol != null && realSol < MIN_CURVE_SOL) {
    block.seen.add(create.mint);
    log(`skip ${create.mint.slice(0, 8)}: curve ${realSol.toFixed(2)} SOL < ${MIN_CURVE_SOL}`);
    persistBlock();
    return;
  }
  const preview = curveFromTrade(trade);
  let buySol = BUY_SOL;
  let entryImpact = null;
  const sized = sizeBuy({
    probe: preview ? (sol) => exitImpactOfBuy(preview, sol)?.spotGapPct : null,
    maxSol: BUY_SOL,
    minSol: Math.min(MIN_BUY_SOL, BUY_SOL),
    maxImpactPct: MAX_EXIT_IMPACT_PCT,
    realSol,
    maxRealPct: MAX_BUY_OF_REAL_PCT,
  });
  entryImpact = sized.impactPct;
  if (sized.skip) {
    block.seen.add(create.mint);
    const reason = sized.reason === "min_buy_exceeds_liquidity"
      ? `real ${realSol?.toFixed?.(2) ?? "?"} SOL caps the buy under ${MIN_BUY_SOL}`
      : `exit impact ${(sized.impactPct ?? 0).toFixed(2)}% at ${sized.sol.toFixed(4)} SOL > ${MAX_EXIT_IMPACT_PCT}%`;
    log(`skip ${create.mint.slice(0, 8)}: ${reason}`);
    journal({
      event: "skip",
      bot: "sniper",
      mint: create.mint,
      skipReason: sized.reason,
      entryLiquiditySol: realSol,
      sizeSol: sized.sol,
      expectedFill: sized.impactPct,
    });
    persistBlock();
    return;
  }
  buySol = sized.sol;
  if (!opts.fromRetry) {
    if (slotsUsed() >= MAX_POSITIONS) return;
    if (Date.now() - lastBuyTime < COOLDOWN_SEC * 1000) return;
  }
  if (positions.has(create.mint) || inflight.has(create.mint)) return;
  const claim = claimHold(holdPath, "sniper", create.mint);
  if (!claim.ok) {
    log(`skip ${create.mint.slice(0, 8)}: held by ${claim.holder}`);
    return;
  }
  if (MIN_DEV_BUY && (!devTrade || devTrade.solAmount < MIN_DEV_BUY)) {
    releaseHold(holdPath, "sniper", create.mint);
    log(`skip: dev buy ${devTrade?.solAmount?.toFixed(3) || 0} < ${MIN_DEV_BUY}`);
    return;
  }

  if (!opts.fromRetry) lastBuyTime = Date.now();
  inflight.add(create.mint);
  const devBuyTokensRaw = devTrade?.tokenAmountRaw ?? null;
  const stats = noteLaunch(creatorPath, create.creator, create.mint);
  const curve = curveFromTrade(trade);
  try {
    log(`\nSNIPING: ${create.mint} size ${buySol.toFixed(4)} SOL (${sized.reason})`);
    log(`  creator: ${create.creator} launches=${stats.launches} rugs=${stats.rugs}`);
    const signals = await collectChainRugSignals({
      mint: create.mint,
      creator: create.creator,
      devBuyTokensRaw,
      creatorLaunches: stats.launches,
      creatorRugs: stats.rugs,
      realSol,
      sameSlotBuyers: opts.sameSlotBuyers ?? null,
      commonFunderPct: opts.commonFunderPct ?? null,
    });
    const filters = ["fresh_curve", sizedReason(buySol), "rug"];
    if (entryConfig.windowMs > 0) filters.push("entry_confirm");
    const meta = {
      creator: create.creator,
      creatorLaunches: stats.launches,
      creatorRugs: stats.rugs,
      devBuyTokensRaw: devBuyTokensRaw == null ? null : devBuyTokensRaw.toString(),
      decimals: signals.decimals || 6,
      curve,
      solIn: buySol,
      entryLiquiditySol: realSol,
      filters,
      entryImpact,
    };
    const gated = await runGuardedBuy({
      bot: "sniper",
      mint: create.mint,
      amountSol: buySol,
      reason: `sniper create by ${create.creator}`,
      dryRun: DRY_RUN,
      autoBuy: AUTO_BUY,
      signals,
      thresholds,
      approvalFile,
      ttlSec: APPROVAL_TTL,
      meta,
      log,
      onPaper: () => paperBuy(create.mint, meta),
      sign: () => signBuy(create.mint, meta),
    });
    if (gated.rug && !gated.rug.ok && !gated.deferred) {
      journal({
        event: "skip",
        bot: "sniper",
        mint: create.mint,
        skipReason: gated.rug.reasons.join("; ") || "rug",
        entryLiquiditySol: realSol,
        sizeSol: buySol,
        filters,
      });
    }
    if (gated.deferred) {
      releaseHold(holdPath, "sniper", create.mint);
      const queued = retries.push(create.mint, 2000, () => considerCreate(create, devTrade, { fromRetry: true }));
      if (!queued) log(`  RUG DEFER give up ${create.mint}: still no chain data, not buying`);
    } else if (!positions.has(create.mint)) {
      releaseHold(holdPath, "sniper", create.mint);
    }
  } catch (err) {
    releaseHold(holdPath, "sniper", create.mint);
    log(`  buy failed: ${err.message}`);
  } finally {
    inflight.delete(create.mint);
  }
}

function keepTokens(tokens, keepFrac) {
  if (tokens == null) return tokens;
  const bps = BigInt(Math.max(0, Math.round(keepFrac * 1_000_000)));
  return ((BigInt(tokens) * bps) / 1_000_000n).toString();
}

async function executeSell(mint, reason, markHint, sellPct = 100) {
  if (exiting.has(mint)) return;
  const pos = positions.get(mint);
  if (!pos) return;
  exiting.add(mint);
  const frac = Math.min(100, Math.max(1, Number(sellPct) || 100)) / 100;
  const partial = frac < 0.999;
  const mintPk = new PublicKey(mint);
  log(`  selling ${mint.slice(0, 8)}... (${reason})`);
  try {
    if (String(reason).startsWith("stop-loss") && pos.creator) noteRug(creatorPath, pos.creator, mint);
    if (DRY_RUN) {
      const hint = markHint && typeof markHint === "object" ? markHint : { simulated: markHint, trigger: markHint, expected: null };
      let sellPrice = hint.simulated;
      if (!(sellPrice > 0)) {
        const state = await getBondingCurveState(mintPk);
        if (state) sellPrice = spotSolPerToken(state.virtualSolReserves, state.virtualTokenReserves, pos.decimals || 6);
      }
      if (String(reason).startsWith("stop-loss") && pos.fillPrice > 0) {
        const fmt = (value) => (value > 0 ? `${Number(value).toExponential(3)} (${(value / pos.fillPrice).toFixed(3)}x)` : "n/a");
        log(`  stop quote: trigger ${fmt(hint.trigger)}, expected ${fmt(hint.expected)}, simulated ${fmt(sellPrice)}`);
      }
      if (sellPrice > 0 && pos.fillPrice > 0) {
        const pnlPct = ((sellPrice / pos.fillPrice) - 1) * 100;
        const basis = Number(pos.solIn || BUY_SOL) * (pos.remainingFrac ?? 1);
        const pnlSol = basis * frac * (pnlPct / 100);
        const holdSec = ((Date.now() - pos.entryTime) / 1000).toFixed(0);
        totalPnl += pnlSol;
        journal({
          event: partial ? "partial" : "close",
          bot: "sniper",
          mint,
          entryLiquiditySol: pos.entryLiquiditySol ?? null,
          sizeSol: basis * frac,
          filters: pos.filters || [],
          exitType: partial ? "partial_take_profit" : exitKind(reason),
          expectedFill: hint.expected ?? null,
          simulatedFill: sellPrice,
          pnlSol,
        });
        if (!partial) {
          totalTrades++;
          if (pnlPct > 0) wins++;
        }
        log(`  [DRY RUN] would sell ${Math.round(frac * 100)}%: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL), held ${holdSec}s`);
        log(`  ${sessionLine()}`);
      }
      if (partial) {
        pos.partialDone = true;
        pos.remainingFrac = (pos.remainingFrac ?? 1) * (1 - frac);
        pos.tokens = keepTokens(pos.tokens, 1 - frac);
        persist();
        return;
      }
      finishMint(mint, reason);
      positions.delete(mint);
      persist();
      return;
    }

    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    const walletTokens = BigInt(info.value.amount);
    const tokenAmount = partial
      ? (walletTokens * BigInt(Math.round(frac * 1_000_000))) / 1_000_000n
      : walletTokens;
    if (tokenAmount === 0n) {
      log(`  no tokens in wallet`);
      finishMint(mint, reason);
      positions.delete(mint);
      persist();
      return;
    }
    const state = await getBondingCurveState(mintPk);
    if (!state || state.complete) {
      log(`  bonding curve complete, cannot sell via pump.fun`);
      finishMint(mint, reason);
      positions.delete(mint);
      persist();
      return;
    }
    const expectedSol = calcSellSol(state, tokenAmount);
    const minSol = (expectedSol * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
    const ixs = [
      ...computeBudgetIxs(),
      sellIx(wallet.publicKey, mintPk, tokenAmount, minSol),
      jitoTipIx(wallet.publicKey),
    ];
    const tx = await buildVersionedTx(wallet, ixs);
    await sendTxWithRetry(tx, { skipPreflight: true });

    const sellPrice = spotSolPerToken(state.virtualSolReserves, state.virtualTokenReserves, pos.decimals || 6);
    const pnlPct = ((sellPrice / pos.fillPrice) - 1) * 100;
    const basis = Number(pos.solIn || BUY_SOL) * (pos.remainingFrac ?? 1);
    const pnlSol = partial ? basis * frac * (pnlPct / 100) : Number(expectedSol) / 1e9 - basis;
    const holdSec = ((Date.now() - pos.entryTime) / 1000).toFixed(0);
    totalPnl += pnlSol;
    journal({
      event: partial ? "partial" : "close",
      bot: "sniper",
      mint,
      entryLiquiditySol: pos.entryLiquiditySol ?? null,
      sizeSol: basis * frac,
      filters: pos.filters || [],
      exitType: partial ? "partial_take_profit" : exitKind(reason),
      expectedFill: Number(expectedSol) / 1e9,
      simulatedFill: sellPrice,
      pnlSol,
    });
    if (partial) {
      pos.partialDone = true;
      pos.remainingFrac = (pos.remainingFrac ?? 1) * (1 - frac);
      pos.tokens = keepTokens(pos.tokens, 1 - frac);
      persist();
      log(`  sold ${Math.round(frac * 100)}%: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL), held ${holdSec}s`);
      return;
    }
    totalTrades++;
    if (pnlSol > 0) wins++;
    log(`  sold: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL), held ${holdSec}s`);
    log(`  ${sessionLine()}`);
    finishMint(mint, reason);
    positions.delete(mint);
    persist();
  } catch (err) {
    log(`  sell failed: ${err.message}`);
  } finally {
    exiting.delete(mint);
  }
}

function noteMark(mint, virtualSol, virtualToken) {
  const pos = positions.get(mint);
  if (!pos) return;
  const mark = spotSolPerToken(virtualSol, virtualToken, pos.decimals || 6);
  if (mark > 0) {
    pos.lastMark = mark;
    pos.lastMarkAt = Date.now();
  }
  const expected = pos.tokens
    ? expectedSellPrice({ virtualSolReserves: virtualSol, virtualTokenReserves: virtualToken }, pos.tokens, pos.decimals || 6)
    : null;
  if (expected > 0) pos.lastExpected = expected;
  const ratio = expected > 0 && pos.fillPrice > 0 ? expected / pos.fillPrice : (mark > 0 && pos.fillPrice > 0 ? mark / pos.fillPrice : null);
  const decision = planExit({
    ratio,
    now: Date.now(),
    entryTime: pos.entryTime,
    stopRatio: STOP_TRIGGER,
    fullTpX: TAKE_PROFIT,
    timeoutSec: TIMEOUT_SEC,
    partialDone: Boolean(pos.partialDone),
    peakRatio: pos.peakRatio ?? 1,
    ...exitConfig,
  });
  pos.peakRatio = decision.peakRatio;
  if (decision.kind === "timeout") return;
  if (decision.action === "sell") {
    const hint = { trigger: mark, expected, simulated: expected };
    executeSell(mint, decision.reason, decision.kind === "stop_loss" ? hint : hint, decision.sellPct);
  }
}

async function checkPositions() {
  const mints = [...positions.keys()];
  const next = nextHeldMint(mints, pollCursor);
  pollCursor = next.cursor;
  if (!next.mint) return;
  const mint = next.mint;
  const pos = positions.get(mint);
  if (!pos) return;
  try {
    const state = await getBondingCurveState(new PublicKey(mint));
    if (!state) {
      await executeSell(mint, "bonding curve gone");
      return;
    }
    if (state.complete) {
      await executeSell(mint, "bonding curve complete");
      return;
    }
    noteMark(mint, state.virtualSolReserves, state.virtualTokenReserves);
  } catch (err) {
    log(`  WARN ${mint.slice(0, 8)}: price poll failed, timeout clock still running: ${err.message}`);
  }
}

function sweepTimeouts() {
  const now = Date.now();
  for (const [mint, pos] of [...positions]) {
    const price = pos.lastExpected > 0 ? pos.lastExpected : pos.lastMark;
    const ratio = price > 0 && pos.fillPrice > 0 ? price / pos.fillPrice : null;
    const decision = planExit({
      ratio,
      now,
      entryTime: pos.entryTime,
      stopRatio: STOP_TRIGGER,
      fullTpX: TAKE_PROFIT,
      timeoutSec: TIMEOUT_SEC,
      partialDone: Boolean(pos.partialDone),
      peakRatio: pos.peakRatio ?? 1,
      ...exitConfig,
    });
    pos.peakRatio = decision.peakRatio;
    if (decision.action !== "sell" || decision.kind !== "timeout") continue;
    const held = ((now - pos.entryTime) / 1000).toFixed(0);
    const { source } = staleExitMark(pos);
    const fresh = source === "last" && pos.lastMarkAt && now - pos.lastMarkAt <= 5000;
    if (!fresh) log(`  WARN ${mint.slice(0, 8)}: timeout ${held}s using ${source} price, no fresh mark`);
    executeSell(mint, decision.reason, { trigger: pos.lastMark, expected: pos.lastExpected, simulated: price });
  }
}

function watchMint(mint) {
  if (!ws || mintSubs.has(mint)) return;
  const id = ws.subscribeLogs(mint, (result) => {
    const logs = result?.value?.logs;
    if (!logs || !positions.has(mint)) return;
    forEachTradeMark(logs, (mark) => {
      if (mark.mint === mint) noteMark(mark.mint, mark.virtualSolReserves, mark.virtualTokenReserves);
    });
  });
  mintSubs.set(mint, id);
}

function unwatchMint(mint) {
  const id = mintSubs.get(mint);
  if (id == null) return;
  ws?.unsubscribe(id);
  mintSubs.delete(mint);
}

function resumeQueuedBuys() {
  if (DRY_RUN) {
    log("DRY-RUN: queued proposals are not signed");
    return;
  }
  const queued = listForBot(approvalFile, "sniper", ["pending", "approved"]);
  for (const item of queued) {
    if (positions.has(item.mint) || inflight.has(item.mint)) continue;
    inflight.add(item.mint);
    log(`resuming proposal ${item.id} (${item.status})`);
    runGuardedBuy({
      existingId: item.id,
      bot: "sniper",
      mint: item.mint,
      amountSol: item.amountSol,
      reason: item.reason,
      dryRun: false,
      autoBuy: false,
      approvalFile,
      ttlSec: APPROVAL_TTL,
      log,
      sign: () => signBuy(item.mint, item.meta || {}),
    }).catch((err) => {
      log(`resume ${item.id} failed: ${err.message}`);
    }).finally(() => inflight.delete(item.mint));
  }
}

log("=== SNIPER BOT (V3) ===");
log(`Wallet: ${wallet.publicKey.toBase58()}`);
log(`Config: buy<=${BUY_SOL} SOL, floor ${MIN_BUY_SOL}, partial ${exitConfig.partialTpPct}% @ ${exitConfig.partialTpX}x, trail ${exitConfig.trailPct} after ${exitConfig.trailActivateX}x, TP=${TAKE_PROFIT}x, SL=${STOP_LOSS}x of fill, trigger ${STOP_TRIGGER.toFixed(3)}x, timeout=${TIMEOUT_SEC}s, max hold ${exitConfig.maxHoldSec}s`);
log(`Entry confirm: ${entryConfig.windowMs}ms, buyers>=${entryConfig.minBuyers}, buy/sell>=${entryConfig.minBuySellRatio}, pump<=${entryConfig.maxPumpX}x`);
log(`Size: <=${MAX_BUY_OF_REAL_PCT}% of real SOL, floor ${MIN_BUY_SOL}. Band ${entryConfig.bandMinSol}-${entryConfig.bandMaxSol} SOL needs buyers>=${entryConfig.bandMinBuyers}, buy/sell>=${entryConfig.bandMinBuySellRatio}`);
log(`Max positions: ${MAX_POSITIONS}, cooldown: ${COOLDOWN_SEC}s, per-token ${TOKEN_COOLDOWN_SEC}s, fresh curve <= ${MAX_CURVE_SOL} SOL`);
log(`Price: per-mint websocket + one held mint every ${POLL_MS}ms. No re-entry after stop: ${NO_REENTRY}`);
log(DRY_RUN
  ? "MODE: DRY RUN (no signatures)"
  : AUTO_BUY
    ? "MODE: AUTO_BUY (signs without manual approval)"
    : `MODE: approval required (${approvalFile}, ttl ${APPROVAL_TTL}s)`);
if (MIN_DEV_BUY) log(`Filter: dev buy >= ${MIN_DEV_BUY} SOL`);
if (positions.size) log(`Resumed ${positions.size} open position(s) from disk`);

resumeQueuedBuys();

ws = new SolanaWs();
attachBotStatus(ROOT, "sniper", () => ({
  dryRun: DRY_RUN,
  autoBuy: AUTO_BUY,
  wsReconnects: ws?.reconnects ?? 0,
  wsLastDataAt: ws?.lastDataAt ?? null,
}));
await ws.connect();
for (const mint of positions.keys()) {
  claimHold(holdPath, "sniper", mint);
  watchMint(mint);
}

function sameSlotCount(events, mint, slot) {
  const users = new Set();
  for (const event of events) {
    if (event.type === "trade" && event.isBuy && event.mint === mint && event.user) users.add(event.user);
  }
  return users.size || null;
}

function observePending(events, slot) {
  for (const event of events) {
    if (event.type !== "trade") continue;
    const row = pending.get(event.mint);
    if (!row) continue;
    const price = event.virtualSolReserves && event.virtualTokenReserves
      ? spotSolPerToken(event.virtualSolReserves, event.virtualTokenReserves, 6)
      : null;
    if (row.launchPrice == null && price > 0) row.launchPrice = price;
    if (price > 0) row.price = price;
    if (event.isBuy) {
      row.buys += 1;
      if (event.user) row.buyers.add(event.user);
      if (slot != null && event.user) {
        const key = String(slot);
        const set = row.slots.get(key) || new Set();
        set.add(event.user);
        row.slots.set(key, set);
      }
    } else {
      row.sells += 1;
    }
  }
}

function slotPeak(row) {
  let peak = 0;
  for (const set of row.slots.values()) peak = Math.max(peak, set.size);
  return peak || null;
}

const skipCounts = new Map();
let lastSkipFlush = Date.now();

function noteSkip(reason) {
  const key = compactSkipKey(reason);
  skipCounts.set(key, (skipCounts.get(key) || 0) + 1);
}

function flushSkips(force = false) {
  const now = Date.now();
  if (!force && now - lastSkipFlush < 30_000) return;
  if (!skipCounts.size) {
    lastSkipFlush = now;
    return;
  }
  const parts = [...skipCounts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} x${count}`);
  log(`skips ${parts.join(", ")}`);
  skipCounts.clear();
  lastSkipFlush = now;
}

async function sweepConfirms() {
  if (!(entryConfig.windowMs > 0)) return;
  const now = Date.now();
  for (const [mint, row] of [...pending]) {
    const realSol = realSolOf(row.devTrade || row.create);
    const bar = thresholdsForLiquidity(realSol, entryConfig);
    const decision = confirmEntry({
      elapsedMs: now - row.started,
      windowMs: entryConfig.windowMs,
      uniqueBuyers: row.buyers.size,
      buys: row.buys,
      sells: row.sells,
      price: row.price,
      launchPrice: row.launchPrice,
      minBuyers: bar.minBuyers,
      minBuySellRatio: bar.minBuySellRatio,
      maxPumpX: entryConfig.maxPumpX,
    });
    if (decision.action === "wait") continue;
    pending.delete(mint);
    if (decision.action === "skip") {
      block.seen.add(mint);
      persistBlock();
      const reason = bar.band
        ? `${decision.reason} (liq ${entryConfig.bandMinSol}-${entryConfig.bandMaxSol})`
        : decision.reason;
      noteSkip(reason);
      journal({
        event: "skip",
        bot: "sniper",
        mint,
        skipReason: reason,
        entryLiquiditySol: realSol,
      });
      continue;
    }
    await considerCreate(row.create, row.devTrade, { sameSlotBuyers: slotPeak(row) });
  }
  flushSkips();
}

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), async (result) => {
  const { value } = result;
  if (!value?.logs) return;
  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;
  const slot = result?.context?.slot ?? null;

  forEachTradeMark(value.logs, (mark) => {
    if (positions.has(mark.mint)) noteMark(mark.mint, mark.virtualSolReserves, mark.virtualTokenReserves);
  });

  const events = parseLogEvents(value.logs);
  observePending(events, slot);
  const creates = events.filter((event) => event.type === "create");
  for (const create of creates) {
    const devTrade = events.find(
      (event) => event.type === "trade" && event.isBuy && event.mint === create.mint && event.user === create.creator,
    );
    if (!(entryConfig.windowMs > 0)) {
      await considerCreate(create, devTrade, { sameSlotBuyers: sameSlotCount(events, create.mint, slot) });
      continue;
    }
    if (pending.has(create.mint) || block.seen.has(create.mint)) continue;
    const row = {
      create,
      devTrade,
      started: Date.now(),
      buyers: new Set(),
      buys: 0,
      sells: 0,
      launchPrice: null,
      price: null,
      slots: new Map(),
    };
    pending.set(create.mint, row);
    observePending(events, slot);
  }
});

setInterval(checkPositions, POLL_MS);
setInterval(sweepTimeouts, 1000);
setInterval(() => { sweepConfirms().catch((err) => log(`  confirm error: ${err.message}`)); }, 500);
setInterval(() => { retries.drain().catch((err) => log(`  retry error: ${err.message}`)); }, 1000);
log("\nListening for new tokens...\n");

process.on("SIGINT", () => {
  log(`\nStopping. ${sessionLine()}. Open positions: ${positions.size}`);
  for (const [mint, pos] of positions) {
    log(`  ${mint.slice(0, 12)}: fill ${Number(pos.fillPrice).toExponential(6)}`);
  }
  persist();
  flushSkips(true);
  ws.close();
  process.exit(0);
});
