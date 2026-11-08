import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RateLimitError,
  createRpcBudget,
  interpretSignatureSample,
  isRateLimitError,
  reserveSlot,
} from "../lib/rpc-budget.mjs";

test("a full signature page is not a count", () => {
  assert.deepEqual(interpretSignatureSample(100, 100), { count: null, capped: true, limit: 100 });
  assert.deepEqual(interpretSignatureSample(40, 100), { count: 40, capped: false, limit: 100 });
  assert.equal(isRateLimitError(new Error("429 Too Many Requests")), true);
  assert.equal(isRateLimitError(new Error("mint missing")), false);
});

test("the budget spaces calls, caches them, and backs off on 429", async () => {
  let clock = 1_000;
  const sleeps = [];
  const budget = createRpcBudget({
    maxPerSec: 2,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    maxRetries: 2,
  });

  let calls = 0;
  await budget.run("one", async () => {
    calls += 1;
    return "a";
  });
  await budget.run("two", async () => {
    calls += 1;
    return "b";
  });
  assert.deepEqual(sleeps, [500]);
  assert.equal(calls, 2);

  let cached = 0;
  await budget.run("same", async () => {
    cached += 1;
    return "hit";
  }, { ttlMs: 5000 });
  assert.equal(await budget.run("same", async () => {
    cached += 1;
    return "miss";
  }, { ttlMs: 5000 }), "hit");
  assert.equal(cached, 1);

  let attempts = 0;
  await assert.rejects(() => budget.run("hot", async () => {
    attempts += 1;
    throw new Error("429 Too Many Requests");
  }), RateLimitError);
  assert.equal(attempts, 3);
  assert.ok(sleeps.some((ms) => ms === 500 || ms === 1000 || ms === 2000));
});

test("in-flight calls for the same key share one result", async () => {
  let clock = 0;
  const budget = createRpcBudget({
    maxPerSec: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = budget.run("k", async () => {
    started += 1;
    await gate;
    return 7;
  });
  const second = budget.run("k", async () => {
    started += 1;
    return 8;
  });
  release();
  assert.equal(await first, 7);
  assert.equal(await second, 7);
  assert.equal(started, 1);
});

test("processes share one slot file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-budget-"));
  const file = path.join(dir, "budget.json");
  const first = reserveSlot(file, 200, 5_000);
  const second = reserveSlot(file, 200, 5_000);
  assert.equal(first, 5_000);
  assert.equal(second, 5_200);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.label, "RPC_BUDGET");
  assert.equal(saved.nextAt, 5_400);
});
