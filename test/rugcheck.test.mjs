import assert from "node:assert/strict";
import test from "node:test";
import {
  collectRugSignals,
  evaluateRug,
  loadThresholds,
  parseMintAuthorities,
  sharePct,
  topHolderPct,
} from "../lib/rugcheck.mjs";

function mintAccount({ supply, mintAuth = false, freeze = false, decimals = 6, initialized = true }) {
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(mintAuth ? 1 : 0, 0);
  if (mintAuth) buf.set(Buffer.alloc(32, 7), 4);
  buf.writeBigUInt64LE(supply, 36);
  buf[44] = decimals;
  buf[45] = initialized ? 1 : 0;
  buf.writeUInt32LE(freeze ? 1 : 0, 46);
  if (freeze) buf.set(Buffer.alloc(32, 9), 50);
  return buf;
}

function cleanSignals(overrides = {}) {
  return {
    mintAuthoritySet: false,
    freezeAuthoritySet: false,
    topHolderPct: 2,
    devBuySharePct: 1,
    creatorLaunches: 1,
    creatorSignatures: 4,
    realSol: 2,
    ...overrides,
  };
}

const thresholds = loadThresholds({});

test("defaults match the documented rug thresholds", () => {
  assert.deepEqual(loadThresholds({}), {
    rejectMintAuthority: true,
    rejectFreezeAuthority: true,
    maxTopHolderPct: 20,
    maxDevBuySharePct: 10,
    maxCreatorLaunches: 3,
    maxCreatorRugs: 0,
    maxCreatorSignatures: 0,
    minRealSol: 0.4,
    failClosed: true,
  });
  const custom = loadThresholds({
    RUG_REJECT_MINT_AUTHORITY: "0",
    RUG_MAX_TOP_HOLDER_PCT: "12.5",
    RUG_MIN_REAL_SOL: "1",
    RUG_FAIL_CLOSED: "false",
  });
  assert.equal(custom.rejectMintAuthority, false);
  assert.equal(custom.maxTopHolderPct, 12.5);
  assert.equal(custom.minRealSol, 1);
  assert.equal(custom.failClosed, false);
});

test("a clean token passes and each risky signal names itself", () => {
  const ok = evaluateRug(cleanSignals(), thresholds);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.reasons, []);

  const cases = [
    [cleanSignals({ mintAuthoritySet: true }), "mint_authority_still_set"],
    [cleanSignals({ freezeAuthoritySet: true }), "freeze_authority_still_set"],
    [cleanSignals({ topHolderPct: 45 }), "top_holder_pct 45.00 > 20.00"],
    [cleanSignals({ devBuySharePct: 25 }), "dev_buy_share_pct 25.00 > 10.00"],
    [cleanSignals({ creatorLaunches: 6 }), "creator_launches 6 > 3"],
    [cleanSignals({ creatorRugs: 2 }), "creator_rugs 2 > 0"],
    [cleanSignals({ realSol: 0.05 }), "thin_liquidity_sol 0.0500 < 0.4000"],
  ];
  for (const [signals, reason] of cases) {
    const result = evaluateRug(signals, thresholds);
    assert.equal(result.ok, false, reason);
    assert.ok(result.reasons.includes(reason), `${result.reasons.join(" | ")} missing ${reason}`);
  }
});

test("a full signature page is unknown and a rate limit is deferred", () => {
  const enabled = loadThresholds({ RUG_MAX_CREATOR_SIGNATURES: "40" });
  const capped = evaluateRug(cleanSignals({
    creatorSignatures: 100,
    creatorSignaturesCapped: true,
    creatorSignatureLimit: 100,
  }), enabled);
  assert.equal(capped.ok, true, capped.reasons.join(" | "));
  assert.ok(capped.notes.some((note) => note.startsWith("creator_signatures_capped_at_")));

  const counted = evaluateRug(cleanSignals({ creatorSignatures: 90, creatorSignaturesCapped: false }), enabled);
  assert.ok(counted.reasons.includes("creator_signatures 90 > 40"));

  const deferred = evaluateRug({ rateLimited: true, mintAuthoritySet: null, realSol: null }, thresholds);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.ok, false);
  assert.deepEqual(deferred.reasons, ["rate_limited_defer"]);
});

test("boundaries and unknown optional creator fields", () => {
  assert.equal(evaluateRug(cleanSignals({ topHolderPct: 20, realSol: 0.4, creatorLaunches: 3, creatorSignatures: 40 }), thresholds).ok, true);
  assert.equal(evaluateRug(cleanSignals({ devBuySharePct: null, creatorLaunches: null, creatorSignatures: null }), thresholds).ok, true);
  const open = evaluateRug(
    { unavailable: "rpc down" },
    loadThresholds({ RUG_FAIL_CLOSED: "0" }),
  );
  assert.equal(open.ok, true);
  const closed = evaluateRug({ unavailable: "rpc down" }, thresholds);
  assert.equal(closed.ok, false);
  assert.ok(closed.reasons.some((reason) => reason.startsWith("rug_data_unavailable:")));
  assert.ok(closed.reasons.includes("mint_authority_unknown"));
  assert.ok(closed.reasons.includes("liquidity_unknown"));
});

test("mint prefix and holder share ignore the bonding curve", () => {
  const parsed = parseMintAuthorities(mintAccount({ supply: 1_000_000_000_000n, mintAuth: true, freeze: true }));
  assert.equal(parsed.mintAuthoritySet, true);
  assert.equal(parsed.freezeAuthoritySet, true);
  assert.equal(parsed.supply, 1_000_000_000_000n);
  assert.equal(parseMintAuthorities(Buffer.alloc(10)), null);

  const pct = topHolderPct(1_000_000_000_000n, [
    { address: "CURVE", amount: "900000000000" },
    { address: "WHALE", amount: "50000000000" },
  ], ["CURVE"]);
  assert.equal(pct, 5);
  assert.equal(sharePct(250_000_000_000n, 1_000_000_000_000n), 25);
  assert.equal(topHolderPct(1_000_000_000_000n, [{ address: "CURVE", amount: "1000" }], ["CURVE"]), 0);
  assert.equal(topHolderPct(1_000_000_000_000n, [], []), null);
});

test("collectRugSignals uses injected readers and never a network", async () => {
  const signals = await collectRugSignals({
    mint: "Mint",
    creator: "Creator",
    devBuyTokensRaw: 20_000_000_000n,
    creatorLaunches: 1,
    excludeAddresses: ["CURVE"],
  }, {
    getMintAccount: async () => mintAccount({ supply: 1_000_000_000_000n }),
    getLargestAccounts: async () => [
      { address: "CURVE", amount: "900000000000" },
      { address: "OTHER", amount: "20000000000" },
    ],
    getCurveState: async () => ({ realSolReserves: 2_000_000_000n }),
    getSignatureCount: async () => 4,
  });
  const result = evaluateRug(signals, thresholds);
  assert.equal(result.ok, true, result.reasons.join(" | "));
  assert.equal(signals.devBuySharePct, 2);
  assert.equal(signals.realSol, 2);
  assert.equal(signals.topHolderPct, 2);

  const missing = await collectRugSignals({ mint: "Mint" }, {
    getMintAccount: async () => null,
    getLargestAccounts: async () => [],
  });
  assert.equal(evaluateRug(missing, thresholds).ok, false);
  assert.equal(missing.unavailable, "mint_account_missing");
});
