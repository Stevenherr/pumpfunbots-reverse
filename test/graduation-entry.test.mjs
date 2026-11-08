import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { entryDecision, loadMintBlock, saveMintBlock } from "../lib/graduation-entry.mjs";
import { createRetryQueue } from "../lib/retry-queue.mjs";

test("confirmation waits, skips a dip, and blocks a stop-out", () => {
  const base = { fillPct: 95, minFillPct: 92, confirmSec: 8, maxDip: 0.02, blocked: false, cooldownUntil: 0 };
  assert.equal(entryDecision({ ...base, now: 0, spot: 1 }).action, "arm");
  assert.equal(entryDecision({ ...base, now: 3000, firstTs: 0, firstSpot: 1, spot: 0.99 }).action, "wait");
  const dip = entryDecision({ ...base, now: 8000, firstTs: 0, firstSpot: 1, spot: 0.97 });
  assert.equal(dip.action, "skip");
  assert.match(dip.reason, /confirm_dip/);
  const stable = entryDecision({ ...base, now: 8000, firstTs: 0, firstSpot: 1, spot: 0.99 });
  assert.equal(stable.action, "buy");
  assert.equal(entryDecision({ ...base, now: 8000, firstTs: 0, firstSpot: 1, spot: 1, blocked: true }).reason, "reentry_after_stop");
  assert.equal(entryDecision({ ...base, now: 1000, spot: 1, cooldownUntil: 5000 }).reason, "token_cooldown");
});

test("stop-out block list reloads", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "block-")), "block.json");
  const stopped = new Set(["MintStop"]);
  const cooldown = new Map([["MintDip", 50_000]]);
  saveMintBlock(file, { stopped, cooldown });
  const loaded = loadMintBlock(file);
  assert.equal(loaded.stopped.has("MintStop"), true);
  assert.equal(loaded.cooldown.get("MintDip"), 50_000);
});

test("retries stop after the attempt cap", async () => {
  const queue = createRetryQueue({ maxAttempts: 2 });
  const runs = [];
  assert.equal(queue.push("mint", 1000, async (n) => runs.push(n), 0), true);
  assert.equal(queue.push("mint", 1000, async (n) => runs.push(n), 0), true);
  assert.equal(queue.push("mint", 1000, async () => runs.push("nope"), 0), false);
  assert.equal(await queue.drain(1000), 1);
  assert.deepEqual(runs, [2]);
  assert.equal(queue.size(), 0);
});
