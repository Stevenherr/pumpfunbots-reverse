import assert from "node:assert/strict";
import test from "node:test";
import { compactSkipKey, confirmEntry, loadEntryConfig, thresholdsForLiquidity } from "../lib/entry-confirm.mjs";
import { entryDecision } from "../lib/graduation-entry.mjs";
import { exitImpactOfBuy } from "../lib/pumpfun.mjs";
import { sizeBuy } from "../lib/sizing.mjs";

const fresh = {
  virtualSolReserves: 30_000_000_000n,
  virtualTokenReserves: 1_073_000_000_000_000n,
};

test("a fresh curve's spot gap does not shrink 0.1 SOL, real liquidity does", () => {
  const gap = exitImpactOfBuy(fresh, 0.1);
  assert.ok(gap.spotGapPct < 0.05, `spot gap ${gap.spotGapPct}`);
  const uncapped = sizeBuy({
    probe: (sol) => exitImpactOfBuy(fresh, sol)?.spotGapPct,
    maxSol: 0.1,
    minSol: 0.02,
    maxImpactPct: 5,
    realSol: 8,
    maxRealPct: 5,
  });
  assert.equal(uncapped.skip, false);
  assert.equal(uncapped.sol, 0.1);
  const thinReal = sizeBuy({
    probe: (sol) => exitImpactOfBuy(fresh, sol)?.spotGapPct,
    maxSol: 0.1,
    minSol: 0.02,
    maxImpactPct: 5,
    realSol: 1.2,
    maxRealPct: 5,
  });
  assert.equal(thinReal.skip, false);
  assert.ok(Math.abs(thinReal.sol - 0.06) < 1e-9);
  assert.equal(thinReal.reason, "scaled_to_liquidity");
  const tooThin = sizeBuy({
    probe: () => 0,
    maxSol: 0.1,
    minSol: 0.02,
    maxImpactPct: 5,
    realSol: 0.2,
    maxRealPct: 5,
  });
  assert.equal(tooThin.skip, true);
  assert.equal(tooThin.reason, "min_buy_exceeds_liquidity");
});

test("the 2-4 SOL band raises confirmation and does not ban the bucket", () => {
  const config = loadEntryConfig({});
  const mid = thresholdsForLiquidity(2.5, config);
  const low = thresholdsForLiquidity(1.2, config);
  const high = thresholdsForLiquidity(6, config);
  assert.equal(mid.band, true);
  assert.equal(mid.minBuyers, 5);
  assert.equal(mid.minBuySellRatio, 2.5);
  assert.equal(low.band, false);
  assert.equal(low.minBuyers, 3);
  assert.equal(high.minBuyers, 3);
  const weak = confirmEntry({
    windowMs: 8000, elapsedMs: 8000, uniqueBuyers: 3, buys: 4, sells: 1,
    price: 1.1, launchPrice: 1, minBuyers: mid.minBuyers, minBuySellRatio: mid.minBuySellRatio,
  });
  assert.equal(weak.action, "skip");
  assert.match(weak.reason, /buyers 3 < 5/);
  const strong = confirmEntry({
    windowMs: 8000, elapsedMs: 8000, uniqueBuyers: 5, buys: 8, sells: 2,
    price: 1.1, launchPrice: 1, minBuyers: mid.minBuyers, minBuySellRatio: mid.minBuySellRatio,
  });
  assert.equal(strong.action, "buy");
  assert.equal(compactSkipKey("buyers 0 < 3"), "buyers<3");
  assert.equal(compactSkipKey("buy_sell_ratio 0.50 < 1.5"), "buy_sell<1.5");
});

test("graduation confirmation can demand a smaller dip and buy pressure", () => {
  const base = { fillPct: 95, minFillPct: 92, confirmSec: 15, maxDip: 0.01, now: 15_000, firstTs: 0, firstSpot: 1 };
  const shaved = entryDecision({ ...base, spot: 0.985 });
  assert.equal(shaved.action, "skip");
  assert.match(shaved.reason, /confirm_dip/);
  const flatWeak = entryDecision({ ...base, spot: 1, buys: 1, sells: 2, minBuys: 3, minBuySellRatio: 1.5 });
  assert.match(flatWeak.reason, /buy_pressure/);
  const flatStrong = entryDecision({ ...base, spot: 0.995, buys: 4, sells: 1, minBuys: 3, minBuySellRatio: 1.5 });
  assert.equal(flatStrong.action, "buy");
});
