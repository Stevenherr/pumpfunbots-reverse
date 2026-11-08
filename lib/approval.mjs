import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";

const TERMINAL_KEEP_MS = 24 * 60 * 60 * 1000;
const FINISH_STATUSES = new Set(["executed", "failed", "cancelled"]);

export function defaultApprovalFile() {
  return process.env.APPROVAL_FILE || path.join(ROOT, "data", "approvals.json");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lock) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      return fs.openSync(lock, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 5000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        // lock disappeared between stat and unlink
      }
      if (Date.now() - start > 2000) throw new Error("approval lock timeout");
      sleepMs(20);
    }
  }
}

function release(lock, fd) {
  fs.closeSync(fd);
  try {
    fs.unlinkSync(lock);
  } catch {
    // another waiter may already have removed a stolen lock
  }
}

function readQueue(file) {
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`approval queue is not a list: ${file}`);
  return raw;
}

function prune(queue, now) {
  return queue.filter((item) => {
    if (item.status === "pending" || item.status === "approved" || item.status === "submitting") return true;
    return now - item.createdAt < TERMINAL_KEEP_MS;
  });
}

function writeQueue(file, queue, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(prune(queue, now), null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function updateQueue(file, now, mutator) {
  const lock = `${file}.lock`;
  const fd = acquire(lock);
  try {
    const queue = readQueue(file);
    const result = mutator(queue);
    writeQueue(file, queue, now);
    return result;
  } finally {
    release(lock, fd);
  }
}

export function expireInPlace(queue, now) {
  for (const item of queue) {
    if ((item.status === "pending" || item.status === "approved") && item.expiresAt <= now) {
      item.status = "expired";
    }
  }
}

export function propose(file, input, now = Date.now()) {
  const ttlSec = input.ttlSec ?? 180;
  return updateQueue(file, now, (queue) => {
    expireInPlace(queue, now);
    const duplicate = queue.find((item) =>
      item.bot === input.bot &&
      item.mint === input.mint &&
      (item.status === "pending" || item.status === "approved" || item.status === "submitting"));
    if (duplicate) return { duplicate: true, item: duplicate };
    const item = {
      id: crypto.randomBytes(4).toString("hex"),
      bot: input.bot,
      mint: input.mint,
      amountSol: input.amountSol,
      reason: input.reason,
      rugCheck: {
        ok: Boolean(input.rugCheck?.ok),
        reasons: input.rugCheck?.reasons ?? [],
        notes: input.rugCheck?.notes ?? [],
      },
      meta: input.meta && typeof input.meta === "object" ? input.meta : null,
      status: "pending",
      createdAt: now,
      expiresAt: now + ttlSec * 1000,
    };
    queue.push(item);
    return { duplicate: false, item };
  });
}

export function decide(file, id, status, now = Date.now()) {
  if (status !== "approved" && status !== "rejected") {
    throw new Error("decision must be approved or rejected");
  }
  return updateQueue(file, now, (queue) => {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return { ok: false, error: "not_found" };
    if ((item.status === "pending" || item.status === "approved") && item.expiresAt <= now) {
      item.status = "expired";
      return { ok: false, error: "expired", item: { ...item } };
    }
    if (item.status !== "pending") return { ok: false, error: item.status, item: { ...item } };
    item.status = status;
    item.decidedAt = now;
    return { ok: true, item: { ...item } };
  });
}

export function claimForSend(file, id, now = Date.now()) {
  return updateQueue(file, now, (queue) => {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return { ok: false, error: "not_found" };
    if (item.status === "approved" && item.expiresAt <= now) {
      item.status = "expired";
      return { ok: false, error: "expired", item: { ...item } };
    }
    if (item.status !== "approved") return { ok: false, error: item.status, item: { ...item } };
    item.status = "submitting";
    item.submittingAt = now;
    return { ok: true, item: { ...item } };
  });
}

export function finishProposal(file, id, status, detail, now = Date.now()) {
  if (!FINISH_STATUSES.has(status)) throw new Error(`unsupported finish status: ${status}`);
  return updateQueue(file, now, (queue) => {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return { ok: false, error: "not_found" };
    item.status = status;
    item.finishedAt = now;
    if (detail) item.detail = String(detail).slice(0, 300);
    return { ok: true, item: { ...item } };
  });
}

export function listProposals(file, now = Date.now()) {
  return updateQueue(file, now, (queue) => {
    expireInPlace(queue, now);
    return queue.map((item) => ({ ...item }));
  });
}

export function listForBot(file, bot, statuses, now = Date.now()) {
  const wanted = new Set(statuses);
  return listProposals(file, now).filter((item) => item.bot === bot && wanted.has(item.status));
}

export function readProposal(file, id, now = Date.now()) {
  return updateQueue(file, now, (queue) => {
    expireInPlace(queue, now);
    const item = queue.find((entry) => entry.id === id);
    return item ? { ...item } : null;
  });
}

export async function waitForDecision(file, id, opts = {}) {
  const pollMs = opts.pollMs ?? 250;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const item = readProposal(file, id, now());
    if (!item) return { status: "missing", id };
    if (item.status !== "pending") return item;
    await sleep(pollMs);
  }
}
