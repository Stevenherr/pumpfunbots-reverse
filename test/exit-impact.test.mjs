import assert from "node:assert/strict";
import test from "node:test";
import { evaluateExit } from "../lib/positions.mjs";
import { curveAfterBuy, exitImpactOfBuy, expectedSellPrice } from "../lib/pumpfun.mjs";

const thin = {
  virtualSolReserves: 400_000_000n,
  virtualTokenReserves: 1_000_000_000_000_000n,
};
const deep = {
  virtualSolReserves: 80_000_000_000n,
  virtualTokenReserves: 1_000_000_000_000_000n,
};

test("a thin curve is filtered and the stop uses the expected sell, not the spot", () => {
  const thinImpact = exitImpactOfBuy(thin, 0.1);
  const deepImpact = exitImpactOfBuy(deep, 0.1);
  assert.ok(thinImpact.spotGapPct > 0.05, `thin gap ${thinImpact.spotGapPct}`);
  assert.ok(deepImpact.spotGapPct < 0.05, `deep gap ${deepImpact.spotGapPct}`);

  const bought = exitImpactOfBuy(thin, 0.1);
  const entry = 0.1 / (Number(bought.tokens) / 1e6);
  const after = curveAfterBuy(thin, 0.1);
  let vSol = after.virtualSolReserves;
  const vTok = after.virtualTokenReserves;
  let found = null;
  for (let i = 0; i < 4000 && vSol > 1n; i++) {
    vSol = vSol * 999n / 1000n;
    const state = { virtualSolReserves: vSol, virtualTokenReserves: vTok };
    const spot = (Number(vSol) / 1e9) / (Number(vTok) / 1e6);
    const expected = expectedSellPrice(state, bought.tokens);
    const spotRatio = spot / entry;
    const expectedRatio = expected / entry;
    if (spotRatio > 0.94 && expectedRatio <= 0.94) {
      found = { spot, expected, spotRatio, expectedRatio };
      break;
    }
  }
  assert.ok(found, "expected a curve where the sell quote is through the stop while spot is not");
  const decision = evaluateExit({
    mark: found.spot,
    expectedFill: found.expected,
    fillPrice: entry,
    entryTime: 0,
    now: 1000,
    stopRatio: 0.94,
    timeoutSec: 120,
  });
  assert.equal(decision.kind, "stop_loss");
  const spotOnly = evaluateExit({
    mark: found.spot,
    fillPrice: entry,
    entryTime: 0,
    now: 1000,
    stopRatio: 0.94,
    timeoutSec: 120,
  });
  assert.equal(spotOnly.action, "hold");
});
