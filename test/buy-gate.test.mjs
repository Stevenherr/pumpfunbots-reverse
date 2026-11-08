import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listProposals } from "../lib/approval.mjs";
import { runGuardedBuy } from "../lib/buy-gate.mjs";
import { loadThresholds } from "../lib/rugcheck.mjs";
import { autoBuyFlag, dryRunFlag } from "../lib/runtime-flags.mjs";

const thresholds = loadThresholds({});

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

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  return path.join(dir, "approvals.json");
}

test("flags default to manual approval and honor explicit opt-in", () => {
  assert.equal(dryRunFlag(["node", "bot"]), false);
  assert.equal(dryRunFlag(["node", "bot", "--dry-run"]), true);
  assert.equal(autoBuyFlag(["node", "bot"], {}), false);
  assert.equal(autoBuyFlag(["node", "bot", "--auto"], {}), true);
  assert.equal(autoBuyFlag(["node", "bot"], { AUTO_BUY: "1" }), true);
  assert.equal(autoBuyFlag(["node", "bot"], { AUTO_BUY: "0" }), false);
});

test("dry-run never signs, even if automatic mode is also set", async () => {
  const file = tempFile();
  let signed = 0;
  let paper = 0;
  const result = await runGuardedBuy({
    bot: "sniper",
    mint: "DryMint",
    amountSol: 0.1,
    reason: "dry",
    dryRun: true,
    autoBuy: true,
    signals: cleanSignals(),
    thresholds,
    approvalFile: file,
    log() {},
    sign: async () => { signed += 1; },
    onPaper: async () => { paper += 1; },
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.signed, false);
  assert.equal(signed, 0);
  assert.equal(paper, 1);
  assert.equal(fs.existsSync(file), false);
});

test("rug rejections are logged and do not sign or queue", async () => {
  const file = tempFile();
  const lines = [];
  let signed = 0;
  const result = await runGuardedBuy({
    bot: "sniper",
    mint: "RugMint",
    amountSol: 0.1,
    reason: "create",
    dryRun: false,
    autoBuy: true,
    signals: cleanSignals({ mintAuthoritySet: true, realSol: 0.01 }),
    thresholds,
    approvalFile: file,
    log: (line) => lines.push(line),
    sign: async () => { signed += 1; },
  });
  assert.equal(result.proceed, false);
  assert.equal(signed, 0);
  assert.equal(fs.existsSync(file), false);
  assert.match(lines.join("\n"), /RUG REJECT RugMint: mint_authority_still_set \| thin_liquidity_sol 0\.0100 < 0\.4000/);
});

test("approval must be explicit before sign, and rejection or expiry signs nothing", async () => {
  const clock = { t: 5_000_000 };
  const file = tempFile();
  let signed = 0;
  const approved = runGuardedBuy({
    bot: "copy-trader",
    mint: "WaitMint",
    amountSol: 0.05,
    reason: "copy buy from target",
    dryRun: false,
    autoBuy: false,
    signals: cleanSignals(),
    thresholds,
    approvalFile: file,
    ttlSec: 30,
    now: () => clock.t,
    log() {},
    sleep: async () => {
      const pending = listProposals(file, clock.t).find((item) => item.mint === "WaitMint" && item.status === "pending");
      if (pending) {
        const { decide } = await import("../lib/approval.mjs");
        decide(file, pending.id, "approved", clock.t);
      }
    },
    sign: async () => { signed += 1; return "signed"; },
  });
  const approvedResult = await approved;
  assert.equal(approvedResult.signed, true);
  assert.equal(approvedResult.mode, "approved");
  assert.equal(signed, 1);
  assert.equal(listProposals(file, clock.t).find((item) => item.mint === "WaitMint").status, "executed");

  const rejectFile = tempFile();
  const rejected = await runGuardedBuy({
    bot: "sniper",
    mint: "NoMint",
    amountSol: 0.1,
    reason: "no",
    dryRun: false,
    autoBuy: false,
    signals: cleanSignals(),
    thresholds,
    approvalFile: rejectFile,
    ttlSec: 30,
    now: () => clock.t,
    log() {},
    sleep: async () => {
      const pending = listProposals(rejectFile, clock.t).find((item) => item.status === "pending");
      const { decide } = await import("../lib/approval.mjs");
      decide(rejectFile, pending.id, "rejected", clock.t);
    },
    sign: async () => { throw new Error("should not sign"); },
  });
  assert.equal(rejected.signed, false);
  assert.equal(rejected.proposal.status, "rejected");

  const expireFile = tempFile();
  const expired = await runGuardedBuy({
    bot: "sniper",
    mint: "OldMint",
    amountSol: 0.1,
    reason: "stale",
    dryRun: false,
    autoBuy: false,
    signals: cleanSignals(),
    thresholds,
    approvalFile: expireFile,
    ttlSec: 10,
    now: () => clock.t,
    log() {},
    sleep: async () => { clock.t += 11_000; },
    sign: async () => { throw new Error("should not sign"); },
  });
  assert.equal(expired.signed, false);
  assert.equal(expired.proposal.status, "expired");
});

test("a failed signature is recorded and not reported as executed", async () => {
  const file = tempFile();
  const now = 9_000_000;
  await assert.rejects(() => runGuardedBuy({
    bot: "sniper",
    mint: "FailMint",
    amountSol: 0.1,
    reason: "fail",
    dryRun: false,
    autoBuy: false,
    signals: cleanSignals(),
    thresholds,
    approvalFile: file,
    ttlSec: 30,
    now: () => now,
    log() {},
    sleep: async () => {
      const pending = listProposals(file, now).find((item) => item.status === "pending");
      const { decide } = await import("../lib/approval.mjs");
      decide(file, pending.id, "approved", now);
    },
    sign: async () => { throw new Error("rpc refused"); },
  }), /rpc refused/);
  assert.equal(listProposals(file, now)[0].status, "failed");
  assert.match(listProposals(file, now)[0].detail, /rpc refused/);
});

test("buy bots keep the dry-run refusal next to the signer", () => {
  for (const rel of [
    "bots/sniper/sniper.mjs",
    "bots/copy-trader/watcher.mjs",
    "bots/graduation-sniper/graduation.mjs",
  ]) {
    const text = fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.match(text, /runGuardedBuy/);
    assert.match(text, /if \(DRY_RUN\) throw new Error\("dry-run refused to sign"\)/);
    assert.match(text, /forEachTradeMark/);
    assert.match(text, /savePositions/);
  }
  const gitignore = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /(^|\n)\.env(\n|$)/);
  assert.match(gitignore, /(^|\n)keys\/(\n|$)/);
  assert.match(gitignore, /(^|\n)data\/(\n|$)/);
});
