import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { confirmEntry, sameSlotBundle } from "../lib/entry-confirm.mjs";
import { planExit } from "../lib/exit-plan.mjs";
import { creatorStatsKnown, noteLaunch, noteRug } from "../lib/creator-history.mjs";
import { paperSnapshot, readOpenPositions } from "../lib/paper-book.mjs";
import { sizeForImpact } from "../lib/sizing.mjs";
import { appendTrade, readTrades, summarize, tradeLogFile } from "../lib/trade-log.mjs";

test("partial take-profit then a trailing stop, with the hard stop and timeout kept", () => {
  const partial = planExit({ ratio: 1.32, peakRatio: 1, partialDone: false, now: 10_000, entryTime: 0 });
  assert.equal(partial.kind, "partial_take_profit");
  assert.equal(partial.sellPct, 50);
  assert.equal(partial.partialDone, true);

  const trail = planExit({
    ratio: 1.2,
    peakRatio: partial.peakRatio > 1.4 ? partial.peakRatio : 1.4,
    partialDone: true,
    now: 20_000,
    entryTime: 0,
  });
  assert.equal(trail.kind, "trailing_stop");
  assert.equal(trail.sellPct, 100);

  const stopped = planExit({ ratio: 0.93, now: 5_000, entryTime: 0 });
  assert.equal(stopped.kind, "stop_loss");

  const full = planExit({ ratio: 2.1, partialDone: false, now: 5_000, entryTime: 0 });
  assert.equal(full.kind, "take_profit");

  const quiet = planExit({ ratio: null, now: 120_000, entryTime: 0, timeoutSec: 120, peakRatio: 1 });
  assert.equal(quiet.kind, "timeout");

  const extended = planExit({
    ratio: 1.22,
    peakRatio: 1.3,
    partialDone: true,
    now: 180_000,
    entryTime: 0,
    timeoutSec: 120,
    maxHoldSec: 600,
    extendTimeout: true,
  });
  assert.equal(extended.action, "hold");
  assert.equal(extended.timeoutExtended, true);
  const capped = planExit({
    ratio: 1.22,
    peakRatio: 1.3,
    partialDone: true,
    now: 600_000,
    entryTime: 0,
    timeoutSec: 120,
    maxHoldSec: 600,
  });
  assert.equal(capped.kind, "timeout");

  const classic = planExit({
    ratio: 1.4,
    partialTpPct: 0,
    trailActivateX: 0,
    fullTpX: 2,
    now: 30_000,
    entryTime: 0,
    timeoutSec: 120,
  });
  assert.equal(classic.action, "hold");
});

test("entry confirmation names the skip and can be turned off", () => {
  assert.equal(confirmEntry({ windowMs: 0, elapsedMs: 0, uniqueBuyers: 0 }).reason, "confirm_off");
  assert.equal(confirmEntry({
    windowMs: 8000, elapsedMs: 1000, uniqueBuyers: 0,
  }).action, "wait");
  const few = confirmEntry({
    windowMs: 8000, elapsedMs: 8000, uniqueBuyers: 1, buys: 1, sells: 0, price: 1, launchPrice: 1,
  });
  assert.equal(few.action, "skip");
  assert.match(few.reason, /buyers 1 < 3/);
  const sold = confirmEntry({
    windowMs: 8000, elapsedMs: 8000, uniqueBuyers: 4, buys: 2, sells: 4, price: 1, launchPrice: 1,
  });
  assert.match(sold.reason, /buy_sell_ratio/);
  const pumped = confirmEntry({
    windowMs: 8000, elapsedMs: 8000, uniqueBuyers: 4, buys: 6, sells: 1, price: 2, launchPrice: 1, maxPumpX: 1.8,
  });
  assert.match(pumped.reason, /pre_entry_pump/);
  const ok = confirmEntry({
    windowMs: 8000, elapsedMs: 8000, uniqueBuyers: 4, buys: 6, sells: 1, price: 1.2, launchPrice: 1,
  });
  assert.equal(ok.action, "buy");
  assert.equal(sameSlotBundle(8, 6).blocked, true);
  assert.equal(sameSlotBundle(2, 6).blocked, false);
  assert.equal(sameSlotBundle(null, 6).reason, "same_slot_buyers_unknown");
});

test("buy size scales down to the exit-impact cap and skips under the floor", () => {
  const scaled = sizeForImpact((sol) => sol, { maxSol: 0.1, minSol: 0.02, maxImpactPct: 5 });
  assert.equal(scaled.skip, false);
  assert.ok(scaled.sol < 0.1);
  assert.ok(scaled.sol >= 0.02);
  assert.ok(scaled.impactPct <= 5.0001);
  const fits = sizeForImpact(() => 0.01, { maxSol: 0.1, minSol: 0.02, maxImpactPct: 5 });
  assert.equal(fits.sol, 0.1);
  assert.equal(fits.reason, "max_fits");
  const skip = sizeForImpact(() => 0.2, { maxSol: 0.1, minSol: 0.02, maxImpactPct: 5 });
  assert.equal(skip.skip, true);
  assert.equal(skip.reason, "min_buy_still_exceeds_impact");
});

test("the trade journal groups pnl by exit, skip, liquidity, hour and bot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trades-"));
  const file = tradeLogFile(dir);
  const morning = Date.UTC(2026, 0, 2, 3, 15);
  appendTrade(file, {
    event: "close", bot: "sniper", mint: "A", ts: morning,
    entryLiquiditySol: 1.2, sizeSol: 0.04, filters: ["fresh_curve"],
    exitType: "timeout", expectedFill: 0.9, simulatedFill: 0.88, pnlSol: -0.01,
  });
  appendTrade(file, {
    event: "partial", bot: "sniper", mint: "B", ts: morning + 3600_000,
    entryLiquiditySol: 4, sizeSol: 0.05, exitType: "partial_take_profit",
    expectedFill: 1.3, simulatedFill: 1.28, pnlSol: 0.02,
  });
  appendTrade(file, {
    event: "close", bot: "graduation-sniper", mint: "C", ts: morning,
    entryLiquiditySol: 20, sizeSol: 0.08, exitType: "trailing_stop", pnlSol: 0.03,
  });
  appendTrade(file, {
    event: "skip", bot: "sniper", mint: "D", ts: morning, skipReason: "buyers 1 < 3",
  });
  const summary = summarize(readTrades(file));
  assert.equal(summary.trades, 3);
  assert.equal(summary.skips, 1);
  assert.equal(summary.wins, 2);
  assert.equal(summary.losses, 1);
  assert.ok(Math.abs(summary.pnlSol - 0.04) < 1e-9);
  assert.equal(summary.byExit.find((row) => row.key === "timeout").count, 1);
  assert.equal(summary.bySkip[0].key, "buyers 1 < 3");
  assert.equal(summary.byLiquidity.find((row) => row.key === "<2").count, 1);
  assert.equal(summary.byLiquidity.find((row) => row.key === "2-10").count, 1);
  assert.equal(summary.byLiquidity.find((row) => row.key === ">10").count, 1);
  assert.equal(summary.byBot.length, 2);
  assert.ok(summary.byHour.length >= 1);

  const posDir = path.join(dir, "positions");
  fs.mkdirSync(posDir);
  fs.writeFileSync(path.join(posDir, "sniper.json"), JSON.stringify({
    label: "POSITIONS",
    positions: [{ mint: "OPEN", solIn: 0.04, fillPrice: 1, lastMark: 1.1, entryTime: morning, partialDone: true }],
  }));
  const open = readOpenPositions(posDir);
  assert.equal(open.length, 1);
  assert.equal(open[0].bot, "sniper");
  assert.equal(open[0].partialDone, true);
  const paper = paperSnapshot(summary, open);
  assert.equal(paper.openCount, 1);
  assert.equal(paper.openSol, 0.04);
});

test("creator history fills a known creator and stays unknown otherwise", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creators-"));
  const file = path.join(dir, "creator-history.json");
  noteLaunch(file, "Alice", "MintA");
  noteRug(file, "Alice", "MintA");
  const known = creatorStatsKnown(file, "Alice");
  assert.equal(known.launches, 1);
  assert.equal(known.rugs, 1);
  assert.equal(creatorStatsKnown(file, "Bob"), null);
  assert.equal(creatorStatsKnown(path.join(dir, "missing.json"), "Alice"), null);
});
