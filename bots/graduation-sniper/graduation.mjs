#!/usr/bin/env node
// Graduation sniper: buy when a bonding curve is nearly full, then take profit / stop / timeout.
// Stop-loss defaults to 0.94 of the fill price and reacts to the trade stream, including sells.
//
//   node bots/graduation-sniper/graduation.mjs [--dry-run] [--auto]

import path from "node:path";
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
  getBondingCurveState,
  sellIx,
} from "../../lib/pumpfun.mjs";
import { entryDecision, loadMintBlock, saveMintBlock } from "../../lib/graduation-entry.mjs";
import { claimHold, heldByOther, heldMintsFile, releaseHold } from "../../lib/held-mints.mjs";
import { nextHeldMint } from "../../lib/sniper-entry.mjs";
import { collectChainRugSignals } from "../../lib/rugcheck-chain.mjs";
import { evaluateRug, loadThresholds } from "../../lib/rugcheck.mjs";
import { connection, sendTxWithRetry } from "../../lib/rpc.mjs";
import { positionPollMs } from "../../lib/rpc-budget.mjs";
import { createRetryQueue } from "../../lib/retry-queue.mjs";
import { approvalTtlSec, autoBuyFlag, dryRunFlag, stopRatio } from "../../lib/runtime-flags.mjs";
import { forEachTradeMark } from "../../lib/trade-event.mjs";
import { buildVersionedTx, computeBudgetIxs, jitoTipIx } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

const BUY_SOL = Number(process.env.GRAD_BUY_SOL || 0.1);
const MIN_FILL_PCT = Number(process.env.GRAD_MIN_FILL_PCT || 92);
const TAKE_PROFIT = Number(process.env.GRAD_TAKE_PROFIT || 1.5);
const STOP_LOSS = stopRatio(process.env.GRAD_STOP_LOSS, DEFAULT_STOP_RATIO);
const STOP_TRIGGER = effectiveStopRatio(STOP_LOSS, earlyStopMargin());
const TIMEOUT_SEC = Number(process.env.GRAD_TIMEOUT_SEC || 300);
const MAX_POSITIONS = Number(process.env.GRAD_MAX_POSITIONS || 3);
const COOLDOWN_SEC = Number(process.env.GRAD_COOLDOWN_SEC || 30);
const TOKEN_COOLDOWN_SEC = Number(process.env.GRAD_TOKEN_COOLDOWN_SEC || 600);
const NO_REENTRY = !["0", "false", "no", "off"].includes(String(process.env.GRAD_NO_REENTRY_AFTER_STOP ?? "1").toLowerCase());
const CONFIRM_SEC = Number(process.env.GRAD_CONFIRM_SEC ?? 8);
const CONFIRM_MAX_DIP = Number(process.env.GRAD_CONFIRM_MAX_DIP ?? 0.02);
const POLL_MS = positionPollMs();
const DRY_RUN = dryRunFlag();
const AUTO_BUY = autoBuyFlag();
const APPROVAL_TTL = approvalTtlSec();
const thresholds = loadThresholds();
const approvalFile = defaultApprovalFile();
const positionPath = positionFile(ROOT, "graduation-sniper");
const blockPath = path.join(ROOT, "data", "graduation-block.json");
const holdPath = heldMintsFile(ROOT);
const block = loadMintBlock(blockPath);
const mintSubs = new Map();
let pollCursor = 0;
let ws;
const retries = createRetryQueue({ maxAttempts: 3 });
const VIRTUAL_SOL_AT_GRADUATION = 85_000_000_000n;

const wallet = loadKeypair();
const positions = loadPositions(positionPath);
const watchlist = new Map();
const inflight = new Set();
const exiting = new Set();
const noted = new Set();
let lastBuyTime = 0;
let totalPnl = 0;
let totalTrades = 0;
let wins = 0;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function persist() {
  savePositions(positionPath, positions);
}

function persistBlock() {
  saveMintBlock(blockPath, { stopped: block.stopped, cooldown: block.cooldown });
}

function tokenBlocked(mint, now = Date.now()) {
  if (NO_REENTRY && block.stopped.has(mint)) return "reentry_after_stop";
  const until = block.cooldown.get(mint) || 0;
  if (until > now) return "token_cooldown";
  return null;
}

function parseV3TradeEvent(data) {
  if (data.length < 129) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const virtualSolReserves = data.readBigUInt64LE(97);
  const virtualTokenReserves = data.readBigUInt64LE(105);
  const realSolReserves = data.readBigUInt64LE(113);
  const realTokenReserves = data.readBigUInt64LE(121);
  return { mint, virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves };
}

function getFillPct(virtualSolReserves) {
  return (Number(virtualSolReserves) / Number(VIRTUAL_SOL_AT_GRADUATION)) * 100;
}

function quoteFill(state, decimals) {
  const tokens = calcBuyTokens(state, BUY_SOL);
  return {
    tokens,
    fillPrice: fillPriceSolPerToken(BUY_SOL, tokens, decimals),
    entrySpot: spotSolPerToken(state.virtualSolReserves, state.virtualTokenReserves, decimals),
  };
}

async function paperBuy(mint, fillPct, decimals, snapshot) {
  const state = snapshot?.virtualSolReserves
    ? snapshot
    : await getBondingCurveState(new PublicKey(mint));
  if (!state || state.complete) {
    log(`  bonding curve already complete or unavailable`);
    return;
  }
  const quote = quoteFill(state, decimals);
  positions.set(mint, {
    tokens: quote.tokens.toString(),
    fillPrice: quote.fillPrice,
    entrySpot: quote.entrySpot,
    solIn: BUY_SOL,
    entryTime: Date.now(),
    fillAtEntry: fillPct,
    decimals,
  });
  persist();
  log(`  [DRY RUN] position tracked, fill ${quote.fillPrice.toExponential(6)} SOL/token`);
}

async function signBuy(mint, fillPct) {
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
    fillAtEntry: fillPct,
    decimals,
  });
  persist();
  log(`  bought, fill ${fill.toExponential(6)} SOL/token`);
}

async function buyToken(mint, fillPct, snapshot, opts = {}) {
  const blocked = opts.fromRetry ? null : tokenBlocked(mint);
  if (blocked) {
    if (!noted.has(`${mint}:${blocked}`)) {
      noted.add(`${mint}:${blocked}`);
      log(`  skip ${mint.slice(0, 12)}: ${blocked}`);
    }
    return;
  }
  if (positions.size + inflight.size >= MAX_POSITIONS) return;
  if (positions.has(mint) || inflight.has(mint)) return;
  if (!opts.fromRetry && Date.now() - lastBuyTime < COOLDOWN_SEC * 1000) return;
  if (heldByOther(holdPath, "graduation-sniper", mint)) {
    log(`  skip ${mint.slice(0, 12)}: held by another bot`);
    return;
  }
  const claim = claimHold(holdPath, "graduation-sniper", mint);
  if (!claim.ok) {
    log(`  skip ${mint.slice(0, 12)}: held by ${claim.holder}`);
    return;
  }
  inflight.add(mint);
  try {
    log(`*** PRE-GRADUATION BUY ***`);
    log(`  mint: ${mint}`);
    log(`  fill: ${fillPct.toFixed(1)}% | buying ${BUY_SOL} SOL`);
    const realSol = snapshot?.realSolReserves == null ? null : Number(snapshot.realSolReserves) / 1e9;
    const signals = await collectChainRugSignals({ mint, realSol });
    const gated = await runGuardedBuy({
      bot: "graduation-sniper",
      mint,
      amountSol: BUY_SOL,
      reason: `graduation fill ${fillPct.toFixed(1)}%`,
      dryRun: DRY_RUN,
      autoBuy: AUTO_BUY,
      signals,
      thresholds,
      approvalFile,
      ttlSec: APPROVAL_TTL,
      meta: { fillPct, decimals: signals.decimals || 6 },
      log,
      onPaper: () => paperBuy(mint, fillPct, signals.decimals || 6, snapshot),
      sign: () => signBuy(mint, fillPct),
    });
    if (gated.deferred) {
      releaseHold(holdPath, "graduation-sniper", mint);
      const queued = retries.push(mint, 2000, () => buyToken(mint, fillPct, snapshot, { fromRetry: true }));
      if (!queued) log(`  RUG DEFER give up ${mint.slice(0, 12)}: still no chain data, not buying`);
      return;
    }
    if (!positions.has(mint)) releaseHold(holdPath, "graduation-sniper", mint);
    else watchMint(mint);
    lastBuyTime = Date.now();
    block.cooldown.set(mint, Date.now() + TOKEN_COOLDOWN_SEC * 1000);
    persistBlock();
  } catch (err) {
    if (!positions.has(mint)) releaseHold(holdPath, "graduation-sniper", mint);
    log(`  buy failed: ${err.message}`);
  } finally {
    inflight.delete(mint);
  }
}

async function sellPosition(mint, reason, pnlMult) {
  if (exiting.has(mint)) return;
  const pos = positions.get(mint);
  if (!pos) return;
  exiting.add(mint);
  const mintPk = new PublicKey(mint);
  const pnlPct = ((pnlMult - 1) * 100);
  const pnlSol = BUY_SOL * (pnlMult - 1);
  log(`  ${mint.slice(0, 12)}: ${reason}`);
  try {
    if (String(reason).startsWith("stop-loss") && NO_REENTRY) {
      block.stopped.add(mint);
      persistBlock();
    }
    releaseHold(holdPath, "graduation-sniper", mint);
    unwatchMint(mint);
    if (DRY_RUN) {
      totalTrades++;
      totalPnl += pnlSol;
      if (pnlMult > 1) wins++;
      log(`  [DRY RUN] sold: ${pnlMult >= 1 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`);
      log(`  session: ${wins}W/${totalTrades - wins}L, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
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
    const state = await getBondingCurveState(mintPk);
    if (!state || state.complete) {
      log(`  cannot sell on bonding curve (graduated), need PumpSwap sell`);
      positions.delete(mint);
      persist();
      return;
    }
    const expectedSol = calcSellSol(state, total);
    const minSol = (expectedSol * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
    const ixs = [
      ...computeBudgetIxs(),
      sellIx(wallet.publicKey, mintPk, total, minSol),
      jitoTipIx(wallet.publicKey),
    ];
    const tx = await buildVersionedTx(wallet, ixs);
    await sendTxWithRetry(tx, { skipPreflight: true });
    totalTrades++;
    totalPnl += pnlSol;
    if (pnlMult > 1) wins++;
    log(`  sold: ${pnlMult >= 1 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`);
    log(`  session: ${wins}W/${totalTrades - wins}L, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
    positions.delete(mint);
    persist();
  } catch (err) {
    log(`  sell failed: ${err.message}`);
  } finally {
    exiting.delete(mint);
  }
}

async function checkExit(mint) {
  const pos = positions.get(mint);
  if (!pos) return;
  const elapsed = (Date.now() - pos.entryTime) / 1000;
  try {
    const state = await getBondingCurveState(new PublicKey(mint));
    if (!state) {
      if (!noted.has(`${mint}:gone`)) {
        noted.add(`${mint}:gone`);
        log(`  ${mint.slice(0, 12)}: bonding curve gone (graduated?), holding for AMM`);
      }
      return;
    }
    if (state.complete) {
      if (!noted.has(`${mint}:complete`)) {
        noted.add(`${mint}:complete`);
        log(`  ${mint.slice(0, 12)}: *** GRADUATED! *** holding for price pump`);
      }
      return;
    }
    const mark = spotSolPerToken(state.virtualSolReserves, state.virtualTokenReserves, pos.decimals || 6);
    const decision = evaluateExit({
      mark,
      fillPrice: pos.fillPrice,
      entryTime: pos.entryTime,
      stopRatio: STOP_TRIGGER,
      takeProfitRatio: TAKE_PROFIT,
      timeoutSec: TIMEOUT_SEC,
    });
    if (decision.action === "sell" && decision.kind !== "timeout" && Number.isFinite(decision.ratio)) {
      await sellPosition(mint, decision.reason, decision.ratio);
    }
  } catch (err) {
    log(`  WARN ${mint.slice(0, 12)}: price poll failed, timeout clock still running: ${err.message}`);
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
  const decision = evaluateExit({
    mark,
    fillPrice: pos.fillPrice,
    entryTime: pos.entryTime,
    stopRatio: STOP_TRIGGER,
    takeProfitRatio: TAKE_PROFIT,
    timeoutSec: TIMEOUT_SEC,
  });
  if (decision.action === "sell" && decision.kind !== "timeout" && Number.isFinite(decision.ratio)) {
    sellPosition(mint, decision.reason, decision.ratio);
  }
}

function sweepTimeouts() {
  const now = Date.now();
  for (const [mint, pos] of [...positions]) {
    if (!timeoutDue(pos.entryTime, now, TIMEOUT_SEC)) continue;
    const held = ((now - pos.entryTime) / 1000).toFixed(0);
    const { price, source } = staleExitMark(pos);
    const ratio = pos.fillPrice > 0 && price > 0 ? price / pos.fillPrice : 1;
    const fresh = source === "last" && pos.lastMarkAt && now - pos.lastMarkAt <= 5000;
    if (!fresh) log(`  WARN ${mint.slice(0, 12)}: timeout ${held}s using ${source} price, no fresh mark`);
    sellPosition(mint, `timeout ${held}s`, ratio);
  }
}

function resumeQueuedBuys() {
  if (DRY_RUN) {
    log("DRY-RUN: queued proposals are not signed");
    return;
  }
  for (const item of listForBot(approvalFile, "graduation-sniper", ["pending", "approved"])) {
    if (positions.has(item.mint) || inflight.has(item.mint)) continue;
    inflight.add(item.mint);
    log(`resuming proposal ${item.id} (${item.status})`);
    runGuardedBuy({
      existingId: item.id,
      bot: "graduation-sniper",
      mint: item.mint,
      amountSol: item.amountSol,
      reason: item.reason,
      dryRun: false,
      autoBuy: false,
      approvalFile,
      ttlSec: APPROVAL_TTL,
      log,
      sign: () => signBuy(item.mint, item.meta?.fillPct || 0),
    }).catch((err) => log(`resume ${item.id} failed: ${err.message}`))
      .finally(() => inflight.delete(item.mint));
  }
}

log("=== GRADUATION SNIPER ===");
log(`Wallet: ${wallet.publicKey.toBase58()}`);
log(`Config: buy=${BUY_SOL} SOL, fill>=${MIN_FILL_PCT}%, TP=${TAKE_PROFIT}x, SL=${STOP_LOSS}x of fill, timeout=${TIMEOUT_SEC}s`);
log(`Max positions: ${MAX_POSITIONS}, global cooldown: ${COOLDOWN_SEC}s, per-token cooldown: ${TOKEN_COOLDOWN_SEC}s`);
log(`Confirm: ${CONFIRM_SEC}s, max dip ${(CONFIRM_MAX_DIP * 100).toFixed(1)}%, no re-entry after stop: ${NO_REENTRY}`);
log(`Price poll: ${POLL_MS}ms backup + trade stream. Stop stays ${STOP_LOSS} of fill; a later fill can lose more than 6% to slippage.`);
log(DRY_RUN
  ? "MODE: DRY RUN (no signatures)"
  : AUTO_BUY
    ? "MODE: AUTO_BUY (signs without manual approval)"
    : `MODE: approval required (${approvalFile}, ttl ${APPROVAL_TTL}s)`);
if (positions.size) log(`Resumed ${positions.size} open position(s) from disk`);
resumeQueuedBuys();

ws = new SolanaWs();
await ws.connect();
for (const mint of positions.keys()) {
  claimHold(holdPath, "graduation-sniper", mint);
  watchMint(mint);
}

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;
  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  forEachTradeMark(value.logs, (mark) => {
    if (positions.has(mark.mint)) noteMark(mark.mint, mark.virtualSolReserves, mark.virtualTokenReserves);
  });

  let isBuy = false;
  for (const line of value.logs) {
    const match = line.match(/Instruction: (\w+)/);
    if (match && BUY_INSTRUCTIONS.has(match[1])) {
      isBuy = true;
      break;
    }
  }
  if (!isBuy) return;

  for (const line of value.logs) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice(14), "base64");
    if (data.length < 129 || !data.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    try {
      const event = parseV3TradeEvent(data);
      if (!event) continue;
      const fillPct = getFillPct(event.virtualSolReserves);
      const spot = spotSolPerToken(event.virtualSolReserves, event.virtualTokenReserves);
      const now = Date.now();
      const prev = watchlist.get(event.mint);
      const decision = entryDecision({
        now,
        firstTs: prev?.firstTs ?? null,
        firstSpot: prev?.firstSpot ?? null,
        spot,
        fillPct,
        minFillPct: MIN_FILL_PCT,
        confirmSec: CONFIRM_SEC,
        maxDip: CONFIRM_MAX_DIP,
        blocked: NO_REENTRY && block.stopped.has(event.mint),
        cooldownUntil: block.cooldown.get(event.mint) || 0,
      });
      if (decision.action === "arm") {
        watchlist.set(event.mint, { firstTs: now, firstSpot: spot, fillPct, ts: now, decided: false });
        log(`WATCHLIST: ${event.mint.slice(0, 12)} fill=${fillPct.toFixed(1)}% confirm ${CONFIRM_SEC}s`);
      } else if (decision.action === "wait" && prev) {
        prev.ts = now;
        prev.fillPct = fillPct;
      } else if (decision.action === "skip") {
        if (decision.reason.startsWith("confirm_dip")) {
          block.cooldown.set(event.mint, now + TOKEN_COOLDOWN_SEC * 1000);
          persistBlock();
          log(`CONFIRM SKIP ${event.mint.slice(0, 12)}: ${decision.reason}`);
        } else if (!noted.has(`${event.mint}:${decision.reason}`)) {
          noted.add(`${event.mint}:${decision.reason}`);
          log(`  skip ${event.mint.slice(0, 12)}: ${decision.reason}`);
        }
        watchlist.delete(event.mint);
      } else if (decision.action === "buy" && prev && !prev.decided && !positions.has(event.mint)) {
        prev.decided = true;
        const snapshot = {
          virtualSolReserves: event.virtualSolReserves,
          virtualTokenReserves: event.virtualTokenReserves,
          realSolReserves: event.realSolReserves,
          complete: false,
        };
        buyToken(event.mint, fillPct, snapshot);
      }
    } catch {}
    break;
  }
});

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

setInterval(() => {
  const next = nextHeldMint([...positions.keys()], pollCursor);
  pollCursor = next.cursor;
  if (next.mint) checkExit(next.mint);
}, POLL_MS);
setInterval(sweepTimeouts, 1000);
setInterval(() => { retries.drain().catch((err) => log(`  retry error: ${err.message}`)); }, 1000);

log("\nListening for near-graduation tokens...\n");

setInterval(() => {
  const now = Date.now();
  for (const [mint, info] of watchlist) {
    if (now - info.ts > 600_000) watchlist.delete(mint);
  }
}, 60_000);

process.on("SIGINT", () => {
  log("\nStopping.");
  log(`  Session: ${totalTrades} trades, ${wins}W/${totalTrades - wins}L`);
  log(`  PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
  log(`  Open positions: ${positions.size}`);
  persist();
  persistBlock();
  ws.close();
  process.exit(0);
});
