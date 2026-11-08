import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claimHold, heldByOther, releaseHold } from "../lib/held-mints.mjs";
import { earlyStopMargin, effectiveStopRatio } from "../lib/positions.mjs";
import { freshLaunchDecision, nextHeldMint } from "../lib/sniper-entry.mjs";

test("only a fresh unseen curve is a sniper launch", () => {
  const base = { isCreate: true, realSol: 1.5, maxRealSol: 12, now: 100 };
  assert.equal(freshLaunchDecision(base).reason, "fresh_create");
  assert.equal(freshLaunchDecision({ ...base, realSol: 35 }).reason.startsWith("curve_not_fresh"), true);
  assert.equal(freshLaunchDecision({ ...base, realSol: null }).reason, "curve_unknown");
  assert.equal(freshLaunchDecision({ ...base, seen: true }).reason, "already_seen");
  assert.equal(freshLaunchDecision({ ...base, stopped: true }).reason, "reentry_after_stop");
  assert.equal(freshLaunchDecision({ ...base, cooldownUntil: 500 }).reason, "token_cooldown");
  assert.equal(freshLaunchDecision({ ...base, heldByOther: true }).reason, "held_by_other_bot");
  assert.equal(freshLaunchDecision({ ...base, isCreate: false }).reason, "not_create");
});

test("held-position polling walks one mint at a time", () => {
  const first = nextHeldMint(["a", "b", "c"], 0);
  const second = nextHeldMint(["a", "b", "c"], first.cursor);
  assert.equal(first.mint, "a");
  assert.equal(second.mint, "b");
  assert.equal(nextHeldMint([], 4).mint, null);
});

test("early stop margin sits above the -6% floor and below 1", () => {
  assert.equal(earlyStopMargin({}), 0.03);
  assert.equal(earlyStopMargin({ STOP_EARLY_MARGIN: "0" }), 0);
  assert.equal(effectiveStopRatio(0.94, 0.03), 0.97);
  assert.equal(effectiveStopRatio(0.94, 0), 0.94);
  assert.equal(effectiveStopRatio(0.94, 0.2), 0.999);
});

test("two bots cannot claim the same mint", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "held-")), "open.json");
  assert.equal(claimHold(file, "sniper", "Mint").ok, true);
  const blocked = claimHold(file, "graduation-sniper", "Mint");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.holder, "sniper");
  assert.equal(heldByOther(file, "graduation-sniper", "Mint"), "sniper");
  releaseHold(file, "sniper", "Mint");
  assert.equal(claimHold(file, "graduation-sniper", "Mint").ok, true);
});
