import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_STOP_RATIO,
  evaluateExit,
  fillPriceSolPerToken,
  loadPositions,
  savePositions,
  shouldStop,
  shouldTakeProfit,
  spotSolPerToken,
} from "../lib/positions.mjs";

test("stop is -6% of the fill, not a looser curve mark", () => {
  assert.equal(DEFAULT_STOP_RATIO, 0.94);
  assert.equal(shouldStop(0.94, 1, 0.94), true);
  assert.equal(shouldStop(0.939, 1, 0.94), true);
  assert.equal(shouldStop(0.941, 1, 0.94), false);
  assert.equal(shouldTakeProfit(2, 1, 2), true);
  assert.equal(shouldTakeProfit(1.99, 1, 2), false);

  const fill = fillPriceSolPerToken(0.1, 1_000_000n, 6);
  assert.equal(fill, 0.1);
  const spot = spotSolPerToken(30_000_000_000n, 1_000_000_000_000n, 6);
  assert.equal(spot, 0.00003);
  assert.equal(fillPriceSolPerToken(0.1, 0n), null);

  const stop = evaluateExit({ mark: 0.93, fillPrice: 1, entryTime: 0, now: 10_000, stopRatio: 0.94, takeProfitRatio: 2, timeoutSec: 120 });
  assert.equal(stop.kind, "stop_loss");
  assert.match(stop.reason, /stop-loss/);
  const held = evaluateExit({ mark: 1, fillPrice: 1, entryTime: 0, now: 121_000, stopRatio: 0.94, takeProfitRatio: 2, timeoutSec: 120 });
  assert.equal(held.kind, "timeout");
});

test("open positions round-trip to disk without secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "positions-"));
  const file = path.join(dir, "sniper.json");
  const positions = new Map([
    ["Mint111", { mint: "Mint111", tokens: 1234n, fillPrice: 0.00012, solIn: 0.1, entryTime: 50, decimals: 6 }],
  ]);
  savePositions(file, positions);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /"label": "POSITIONS"/);
  assert.doesNotMatch(text, /secret|keypair|private/i);
  const loaded = loadPositions(file);
  assert.equal(loaded.get("Mint111").tokens, "1234");
  assert.equal(loaded.get("Mint111").fillPrice, 0.00012);
  assert.equal(loadPositions(path.join(dir, "missing.json")).size, 0);
});
