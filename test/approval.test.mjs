import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claimForSend, decide, listProposals, propose, waitForDecision } from "../lib/approval.mjs";
import { handleApprovalHttp, isLoopback } from "../lib/approval-http.mjs";

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approvals-"));
  return path.join(dir, "approvals.json");
}

test("approve, reject, and expiry do not invent a signature", async () => {
  const file = tempFile();
  const now = 1_000_000;
  const created = propose(file, {
    bot: "sniper",
    mint: "MintA",
    amountSol: 0.1,
    reason: "sniper create",
    rugCheck: { ok: true, reasons: [], notes: ["mint_authority_clear"] },
    ttlSec: 180,
  }, now);
  assert.equal(created.duplicate, false);
  assert.equal(created.item.status, "pending");
  assert.equal(created.item.rugCheck.ok, true);

  const rejectedFile = tempFile();
  const rejectedItem = propose(rejectedFile, {
    bot: "copy-trader", mint: "MintB", amountSol: 0.05, reason: "copy", rugCheck: { ok: true }, ttlSec: 10,
  }, now).item;
  const rejected = decide(rejectedFile, rejectedItem.id, "rejected", now);
  assert.equal(rejected.ok, true);
  assert.equal(rejected.item.status, "rejected");

  const expired = decide(file, created.item.id, "approved", now + 180_000);
  assert.equal(expired.ok, false);
  assert.equal(expired.error, "expired");

  const live = propose(file, {
    bot: "sniper", mint: "MintC", amountSol: 0.1, reason: "again", rugCheck: { ok: true }, ttlSec: 50,
  }, now + 180_000);
  const approved = decide(file, live.item.id, "approved", now + 180_000);
  assert.equal(approved.ok, true);
  const claim = claimForSend(file, live.item.id, now + 180_000);
  assert.equal(claim.ok, true);
  assert.equal(claim.item.status, "submitting");
  const second = claimForSend(file, live.item.id, now + 180_000);
  assert.equal(second.ok, false);

  let polls = 0;
  const clock = now + 180_000;
  const decision = await waitForDecision(rejectedFile, rejectedItem.id, {
    pollMs: 1,
    now: () => clock,
    sleep: async () => { polls += 1; },
  });
  assert.equal(decision.status, "rejected");
  assert.equal(polls, 0);
});

test("local approval HTTP approves and refuses remote posts", async () => {
  const file = tempFile();
  const created = propose(file, {
    bot: "graduation-sniper",
    mint: "MintLocal",
    amountSol: 0.1,
    reason: "graduation fill 95.0%",
    rugCheck: { ok: true, reasons: [], notes: [] },
    ttlSec: 180,
  });

  const remote = { socket: { remoteAddress: "203.0.113.5" }, method: "POST", url: `/api/approvals/${created.item.id}/approve` };
  const remoteRes = fakeRes();
  assert.equal(handleApprovalHttp(remote, remoteRes, { file }), true);
  assert.equal(remoteRes.status, 403);
  assert.equal(listProposals(file).find((item) => item.id === created.item.id).status, "pending");

  const server = http.createServer((req, res) => {
    if (!handleApprovalHttp(req, res, { file })) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/api/approvals`);
    const body = await listed.json();
    assert.equal(body.proposals.some((item) => item.id === created.item.id && item.status === "pending"), true);
    const approved = await fetch(`http://127.0.0.1:${port}/api/approvals/${created.item.id}/approve`, { method: "POST" });
    const approvedBody = await approved.json();
    assert.equal(approved.status, 200);
    assert.equal(approvedBody.item.status, "approved");
    assert.equal(isLoopback({ socket: { remoteAddress: "127.0.0.1" } }), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function fakeRes() {
  return {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
}
