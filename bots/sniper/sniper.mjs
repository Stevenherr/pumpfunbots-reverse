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
import { historyFile, noteLaunch, noteRug } from "../../lib/creator-history.mjs";
import { loadMintBlock, saveMintBlock } from "../../lib/graduation-entry.mjs";
import { claimHold, heldByOther, heldMintsFile, releaseHold } from "../../lib/held-mints.mjs";
import { ROOT, SLIPPAGE_BPS } from "../../lib/config.mjs";
import {
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  CREATE_INSTRUCTIONS,
} from "../../lib/constants.mjs";
import {
  DEFAULT_STOP_RATIO,
  earlyStopMargin,
  effectiveStopRatio,
  evaluateExit,
  staleExitMark,
  timeoutDue,
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
  let isBuy = false, isCreate = false;
  for (const line of logs) {
    const m = line.match(/Instruction: (\w+)/);
    if (!m) continue;
    if (BUY_INSTRUCTIONS.has(m[1])) isBuy = true;
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
      if (isBuy) events.push({ type: "trade", isBuy: true, ...parsed });
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
  const quote = quoteFill(state, context.decimals || 6);
  remember(mint, {
    tokens: quote.tokens.toString(),
    fillPrice: quote.fillPrice,
    entrySpot: quote.entrySpot,
    solIn: BUY_SOL,
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
  const quote = quoteFill(state, decimals);
  const minTokens = (quote.tokens * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
  log(`  buying ${BUY_SOL} SOL -> ~${(Number(quote.tokens) / 10 ** decimals).toFixed(0)} tokens`);

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
  remember(mint, {
    tokens: tokens.toString(),
    fillPrice: fill,
    entrySpot: quote.entrySpot,
    solIn: BUY_SOL,
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
  if (preview) {
    const impact = exitImpactOfBuy(preview, BUY_SOL);
    if (impact && impact.spotGapPct * 100 > MAX_EXIT_IMPACT_PCT) {
      block.seen.add(create.mint);
      log(`skip ${create.mint.slice(0, 8)}: exit impact ${(impact.spotGapPct * 100).toFixed(2)}% > ${MAX_EXIT_IMPACT_PCT}%`);
      persistBlock();
      return;
    }
  }
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
    log(`\nSNIPING: ${create.mint}`);
    log(`  creator: ${create.creator} launches=${stats.launches} rugs=${stats.rugs}`);
    const signals = await collectChainRugSignals({
      mint: create.mint,
      creator: create.creator,
      devBuyTokensRaw,
      creatorLaunches: stats.launches,
      creatorRugs: stats.rugs,
      realSol,
    });
    const meta = {
      creator: create.creator,
      creatorLaunches: stats.launches,
      creatorRugs: stats.rugs,
      devBuyTokensRaw: devBuyTokensRaw == null ? null : devBuyTokensRaw.toString(),
      decimals: signals.decimals || 6,
      curve,
    };
    const gated = await runGuardedBuy({
      bot: "sniper",
      mint: create.mint,
      amountSol: BUY_SOL,
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

async function executeSell(mint, reason, markHint) {
  if (exiting.has(mint)) return;
  const pos = positions.get(mint);
  if (!pos) return;
  exiting.add(mint);
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
        const pnlSol = BUY_SOL * (pnlPct / 100);
        const holdSec = ((Date.now() - pos.entryTime) / 1000).toFixed(0);
        totalTrades++;
        totalPnl += pnlSol;
        if (pnlPct > 0) wins++;
        log(`  [DRY RUN] would sell: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL), held ${holdSec}s`);
        log(`  ${sessionLine()}`);
      }
      finishMint(mint, reason);
      positions.delete(mint);
      persist();
      return;
    }

    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    const tokenAmount = BigInt(info.value.amount);
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
    const pnlSol = Number(expectedSol) / 1e9 - BUY_SOL;
    const holdSec = ((Date.now() - pos.entryTime) / 1000).toFixed(0);
    totalPnl += pnlSol;
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
  const decision = evaluateExit({
    mark,
    expectedFill: expected,
    fillPrice: pos.fillPrice,
    entryTime: pos.entryTime,
    stopRatio: STOP_TRIGGER,
    takeProfitRatio: TAKE_PROFIT,
    timeoutSec: TIMEOUT_SEC,
  });
  if (decision.kind === "stop_loss") {
    executeSell(mint, decision.reason, { trigger: mark, expected, simulated: expected });
  } else if (decision.action === "sell") {
    executeSell(mint, decision.reason, mark);
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
    if (!timeoutDue(pos.entryTime, now, TIMEOUT_SEC)) continue;
    const held = ((now - pos.entryTime) / 1000).toFixed(0);
    const { price, source } = staleExitMark(pos);
    const fresh = source === "last" && pos.lastMarkAt && now - pos.lastMarkAt <= 5000;
    if (!fresh) log(`  WARN ${mint.slice(0, 8)}: timeout ${held}s using ${source} price, no fresh mark`);
    executeSell(mint, `timeout ${held}s`, price);
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
log(`Config: buy=${BUY_SOL} SOL, TP=${TAKE_PROFIT}x, SL=${STOP_LOSS}x of fill, trigger ${STOP_TRIGGER.toFixed(3)}x, timeout=${TIMEOUT_SEC}s`);
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
await ws.connect();
for (const mint of positions.keys()) {
  claimHold(holdPath, "sniper", mint);
  watchMint(mint);
}

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), async (result) => {
  const { value } = result;
  if (!value?.logs) return;
  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  forEachTradeMark(value.logs, (mark) => {
    if (positions.has(mark.mint)) noteMark(mark.mint, mark.virtualSolReserves, mark.virtualTokenReserves);
  });

  const events = parseLogEvents(value.logs);
  const creates = events.filter((event) => event.type === "create");
  for (const create of creates) {
    const devTrade = events.find(
      (event) => event.type === "trade" && event.isBuy && event.mint === create.mint && event.user === create.creator,
    );
    await considerCreate(create, devTrade);
  }
});

setInterval(checkPositions, POLL_MS);
setInterval(sweepTimeouts, 1000);
setInterval(() => { retries.drain().catch((err) => log(`  retry error: ${err.message}`)); }, 1000);
log("\nListening for new tokens...\n");

process.on("SIGINT", () => {
  log(`\nStopping. ${sessionLine()}. Open positions: ${positions.size}`);
  for (const [mint, pos] of positions) {
    log(`  ${mint.slice(0, 12)}: fill ${Number(pos.fillPrice).toExponential(6)}`);
  }
  persist();
  ws.close();
  process.exit(0);
});
