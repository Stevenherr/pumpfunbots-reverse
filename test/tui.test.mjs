import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeBotStatus } from "../lib/bot-status.mjs";
import { buildSnapshot } from "../lib/tui-model.mjs";
import { renderSnapshot, visibleLength } from "../lib/tui-view.mjs";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-"));
  const data = path.join(root, "data");
  const logs = path.join(root, "logs");
  write(path.join(data, "trades.jsonl"), [
    JSON.stringify({ label: "TRADE", event: "close", bot: "sniper", mint: "MintAAAAxxxxxxxx", ts: NOW - 60_000, entryLiquiditySol: 1.2, sizeSol: 0.04, exitType: "timeout", pnlSol: -0.004, simulatedFill: 0.9, expectedFill: 0.92 }),
    JSON.stringify({ label: "TRADE", event: "partial", bot: "sniper", mint: "MintBBBBxxxxxxxx", ts: NOW - 30_000, entryLiquiditySol: 4, sizeSol: 0.05, exitType: "partial_take_profit", pnlSol: 0.015 }),
    JSON.stringify({ label: "TRADE", event: "close", bot: "graduation-sniper", mint: "MintCCCCxxxxxxxx", ts: NOW - 10_000, entryLiquiditySol: 12, sizeSol: 0.08, exitType: "trailing_stop", pnlSol: 0.02 }),
    JSON.stringify({ label: "TRADE", event: "skip", bot: "sniper", mint: "MintDDDD", ts: NOW - 5_000, skipReason: "buyers 1 < 3" }),
    JSON.stringify({ label: "TRADE", event: "skip", bot: "sniper", mint: "MintEEEE", ts: NOW - 4_000, skipReason: "buyers 1 < 3" }),
    JSON.stringify({ label: "TRADE", event: "skip", bot: "sniper", mint: "MintFFFF", ts: NOW - 3_000, skipReason: "min_buy_still_exceeds_impact" }),
  ].join("\n") + "\n");
  write(path.join(data, "positions", "sniper.json"), JSON.stringify({
    label: "POSITIONS",
    positions: [{
      mint: "OpenMint1111111111111111111111111111111111",
      solIn: 0.04,
      fillPrice: 1,
      lastMark: 1.12,
      entryTime: NOW - 40_000,
      partialDone: false,
      peakRatio: 1.2,
      entryLiquiditySol: 3,
    }],
  }));
  write(path.join(data, "approvals.json"), JSON.stringify([
    { id: "ab12cd34", bot: "sniper", mint: "PendingMintxxxxxxxx", amountSol: 0.04, status: "pending", expiresAt: NOW + 120_000 },
    { id: "done", bot: "sniper", mint: "Old", amountSol: 0.04, status: "rejected", expiresAt: NOW + 120_000 },
  ]));
  write(path.join(data, "rpc-budget.json"), JSON.stringify({ label: "RPC_BUDGET", nextAt: NOW + 400 }));
  write(path.join(data, "open-mints.json"), JSON.stringify({
    label: "OPEN_MINTS",
    mints: [{ mint: "OpenMint1111111111111111111111111111111111", bot: "sniper" }],
  }));
  writeBotStatus(root, "sniper", {
    pid: process.pid,
    startedAt: NOW - 120_000,
    dryRun: true,
    autoBuy: false,
    wsReconnects: 2,
    wsLastDataAt: NOW - 2_000,
  });
  writeBotStatus(root, "graduation-sniper", {
    pid: process.pid,
    startedAt: NOW - 120_000,
    dryRun: true,
    autoBuy: false,
    wsReconnects: 4,
    wsLastDataAt: NOW - 60_000,
  });
  write(path.join(logs, "analytics.log"), "[12:00:00] MODE: DRY RUN (no signatures)\n[ws] disconnected; reconnect #3 in 4000ms\n");
  return { root, data, logs };
}

test("snapshot aggregates files and does not touch rpc or approvals", () => {
  const { root, data } = fixture();
  const beforeRpc = fs.readFileSync(path.join(data, "rpc-budget.json"), "utf8");
  const beforeApprovals = fs.readFileSync(path.join(data, "approvals.json"), "utf8");
  const model = buildSnapshot({
    root,
    logDir: path.join(root, "logs"),
    now: NOW,
    env: {},
    processes: [],
    analyticsHttp: false,
  });
  assert.equal(fs.readFileSync(path.join(data, "rpc-budget.json"), "utf8"), beforeRpc);
  assert.equal(fs.readFileSync(path.join(data, "approvals.json"), "utf8"), beforeApprovals);
  assert.equal(model.mode, "dry");
  assert.equal(model.holds, 1);
  assert.equal(model.summary.wins, 2);
  assert.equal(model.summary.losses, 1);
  assert.ok(Math.abs(model.summary.pnlSol - 0.031) < 1e-9);
  assert.equal(model.positions.length, 1);
  assert.ok(model.positions[0].markRatio > 1.1);
  assert.ok(model.positions[0].trailRatio > 1);
  assert.equal(model.positions[0].ageSec, 40);
  assert.equal(model.closes[0].exitType, "trailing_stop");
  assert.ok(model.closes.every((row) => row.multiple > 0));
  assert.equal(model.skips[0].key, "buyers 1 < 3");
  assert.equal(model.skips[0].count, 2);
  assert.equal(model.approvals.length, 1);
  assert.equal(model.approvals[0].command, "node bots/approve.mjs approve ab12cd34");
  assert.equal(model.rpc.waitMs, 400);
  const sniper = model.bots.find((bot) => bot.id === "sniper");
  const grad = model.bots.find((bot) => bot.id === "graduation-sniper");
  const analytics = model.bots.find((bot) => bot.id === "analytics");
  assert.equal(sniper.alive, true);
  assert.equal(sniper.reconnects, 2);
  assert.equal(sniper.stale, false);
  assert.equal(grad.stale, true);
  assert.equal(grad.reconnects, 4);
  assert.equal(analytics.alive, false);
  assert.equal(analytics.reconnects, 3);

  const live = buildSnapshot({
    root,
    now: NOW,
    env: {},
    processes: [],
    isAlive: (pid) => pid === process.pid,
  });
  writeBotStatus(root, "sniper", { pid: process.pid, startedAt: NOW - 10_000, dryRun: false, wsReconnects: 1, wsLastDataAt: NOW });
  const warned = buildSnapshot({ root, now: NOW, env: {}, processes: [], analyticsHttp: null });
  assert.equal(warned.mode, "live");
  assert.equal(live.mode, "dry");
});

test("plain render fits 80x24 and names the panels", () => {
  const { root } = fixture();
  const model = buildSnapshot({ root, logDir: path.join(root, "logs"), now: NOW, env: {}, processes: [], analyticsHttp: false });
  const text = renderSnapshot(model, { width: 80, height: 24, color: false });
  const lines = text.split("\n");
  assert.ok(lines.length <= 24);
  assert.ok(lines.length >= 12);
  for (const row of lines) assert.ok(visibleLength(row) <= 80, row);
  assert.match(text, /DRY RUN/);
  assert.match(text, /timeout/);
  assert.match(text, /trailing_stop/);
  assert.match(text, /buyers 1 < 3/);
  assert.match(text, /node bots\/approve\.mjs approve ab12cd34/);
  assert.match(text, /STALE/);
  assert.match(text, /next slot 400ms/);
  assert.doesNotMatch(text, /LIVE — NOT DRY RUN/);

  const wide = renderSnapshot(model, { width: 100, height: 40, color: false });
  assert.match(wide, /partial_take_profit/);
  assert.ok(wide.split("\n").length <= 40);
  for (const row of wide.split("\n")) assert.ok(visibleLength(row) <= 100);
});

test("--once prints a snapshot and does not approve", () => {
  const { root, data } = fixture();
  const before = fs.readFileSync(path.join(data, "approvals.json"), "utf8");
  const result = spawnSync(process.execPath, [
    "bots/tui/dashboard.mjs", "--once", "--root", root, "--log-dir", path.join(root, "logs"),
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, TUI_NO_HTTP: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/);
  assert.match(result.stdout, /node bots\/approve\.mjs approve ab12cd34/);
  assert.equal(fs.readFileSync(path.join(data, "approvals.json"), "utf8"), before);
  const src = fs.readFileSync("bots/tui/dashboard.mjs", "utf8") + fs.readFileSync("lib/tui-model.mjs", "utf8");
  assert.doesNotMatch(src, /reserveSlot|sendTransaction|decide\(/);
});
