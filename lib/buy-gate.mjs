import { claimForSend, finishProposal, propose, waitForDecision } from "./approval.mjs";
import { evaluateRug, loadThresholds } from "./rugcheck.mjs";

function say(opts, message) {
  (opts.log || console.log)(message);
}

// Decides whether a buy may be signed.
// --dry-run returns before any queue write and before sign.
// AUTO_BUY skips the queue. Otherwise the proposal must be explicitly approved.
export async function gateBuy(opts) {
  const nowFn = opts.now || (() => Date.now());
  const thresholds = opts.thresholds ?? loadThresholds();
  let rug = opts.rug ?? null;

  if (!opts.existingId) {
    rug = evaluateRug(opts.signals, thresholds);
    if (!rug.ok) {
      say(opts, `RUG REJECT ${opts.mint}: ${rug.reasons.join(" | ")}`);
      return { proceed: false, rug, signed: false };
    }
    say(opts, `RUG OK ${opts.mint}: ${rug.notes.join(" | ")}`);
    if (opts.dryRun) {
      say(opts, `DRY-RUN ${opts.mint}: no signature, no approval queue`);
      return { proceed: true, mode: "dry-run", rug, signed: false };
    }
    if (opts.autoBuy) {
      say(opts, `AUTO_BUY ${opts.mint}: signing without manual approval`);
      return { proceed: true, mode: "auto", rug, signed: false };
    }
  } else if (opts.dryRun) {
    say(opts, `DRY-RUN ${opts.mint}: ignoring queued proposal ${opts.existingId}`);
    return { proceed: false, mode: "dry-run", rug, signed: false };
  }

  let proposal = null;
  let proposalId = opts.existingId || null;
  if (!proposalId) {
    const created = propose(opts.approvalFile, {
      bot: opts.bot,
      mint: opts.mint,
      amountSol: opts.amountSol,
      reason: opts.reason,
      rugCheck: { ok: true, reasons: rug.reasons, notes: rug.notes },
      meta: opts.meta ?? null,
      ttlSec: opts.ttlSec,
    }, nowFn());
    proposal = created.item;
    proposalId = proposal.id;
    if (created.duplicate) {
      say(opts, `APPROVAL ${proposal.id} already ${proposal.status} for ${opts.mint}`);
    } else {
      say(opts, `APPROVAL ${proposal.id} pending ${opts.mint} amount=${opts.amountSol} SOL`);
      say(opts, `  reason: ${opts.reason}`);
      say(opts, `  rug-check: ok`);
      say(opts, `  expires: ${new Date(proposal.expiresAt).toISOString()}`);
      say(opts, `  approve: node bots/approve.mjs approve ${proposal.id}`);
    }
    if (proposal.status === "submitting" || proposal.status === "executed") {
      return { proceed: false, rug, proposal, signed: false };
    }
  }

  let decision = proposal;
  if (!decision || decision.status === "pending") {
    decision = await waitForDecision(opts.approvalFile, proposalId, {
      pollMs: opts.pollMs ?? 250,
      now: nowFn,
      sleep: opts.sleep,
    });
  }
  if (!decision || decision.status !== "approved") {
    const status = decision?.status || "missing";
    say(opts, `APPROVAL ${proposalId} ${status}: not signing`);
    return { proceed: false, mode: "approval", rug, proposal: decision, signed: false };
  }

  const claim = claimForSend(opts.approvalFile, proposalId, nowFn());
  if (!claim.ok) {
    say(opts, `APPROVAL ${proposalId} not claimable (${claim.error}): not signing`);
    return { proceed: false, mode: "approval", rug, proposal: claim.item, signed: false };
  }
  say(opts, `APPROVAL ${proposalId} granted: signing ${opts.mint}`);
  return {
    proceed: true,
    mode: "approved",
    rug,
    proposal: claim.item,
    proposalId,
    signed: false,
  };
}

export async function runGuardedBuy(opts) {
  const gate = await gateBuy(opts);
  if (!gate.proceed) return { ...gate, signed: false };
  if (opts.dryRun || gate.mode === "dry-run") {
    await opts.onPaper?.(gate);
    return { ...gate, signed: false };
  }
  if (typeof opts.sign !== "function") {
    throw new Error("refusing to buy without a sign callback");
  }
  const now = opts.now || (() => Date.now());
  try {
    const result = await opts.sign(gate);
    if (gate.proposalId) finishProposal(opts.approvalFile, gate.proposalId, "executed", undefined, now());
    return { ...gate, signed: true, result };
  } catch (err) {
    if (gate.proposalId) finishProposal(opts.approvalFile, gate.proposalId, "failed", err.message, now());
    throw err;
  }
}
