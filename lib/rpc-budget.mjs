import fs from "node:fs";
import path from "node:path";

// Shared request budget for a free RPC plan. One process shares the in-memory
// bucket; reserveSlot() also serializes several bot processes through a file.
// A 429 is a pause and a retry, not a reason to buy and not a rug signal.

export class RateLimitError extends Error {
  constructor(message, retryAfterMs = 500) {
    super(message);
    this.name = "RateLimitError";
    this.rateLimited = true;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRateLimitError(err) {
  if (!err) return false;
  if (err.rateLimited || err.name === "RateLimitError") return true;
  const text = `${err.message || ""} ${err.code || ""}`;
  return /429|too many requests|rate limit|-32429/i.test(text);
}

export function interpretSignatureSample(returned, limit) {
  const count = Number(returned);
  const page = Number(limit);
  if (!Number.isFinite(count) || !Number.isFinite(page) || page <= 0) {
    return { count: null, capped: false, limit: page };
  }
  if (count >= page) return { count: null, capped: true, limit: page };
  return { count, capped: false, limit: page };
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
        // the lock vanished between stat and retry
      }
      if (Date.now() - start > 2000) throw new Error("rpc budget lock timeout");
      sleepMs(15);
    }
  }
}

function release(lock, fd) {
  fs.closeSync(fd);
  try { fs.unlinkSync(lock); } catch { /* already gone */ }
}

// Returns the timestamp when this process may send. Advances the shared slot.
export function reserveSlot(file, spacingMs, now = Date.now()) {
  const spacing = Math.max(1, Math.ceil(spacingMs));
  const lock = `${file}.lock`;
  const fd = acquire(lock);
  try {
    let nextAt = 0;
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw?.label !== "RPC_BUDGET") throw new Error("refusing rpc budget file without RPC_BUDGET label");
      nextAt = Number(raw.nextAt) || 0;
    }
    const slot = Math.max(nextAt, now);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ label: "RPC_BUDGET", nextAt: slot + spacing })}\n`);
    fs.renameSync(tmp, file);
    return slot;
  } finally {
    release(lock, fd);
  }
}

export function createRpcBudget({
  maxPerSec = 5,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRetries = 3,
  reserve = null,
} = {}) {
  const spacing = Math.max(1, Math.ceil(1000 / Math.max(maxPerSec, 0.1)));
  let nextAt = 0;
  let penaltyMs = 500;
  const cache = new Map();
  const inflight = new Map();

  async function waitTurn() {
    let slot;
    if (reserve) {
      try {
        slot = reserve();
      } catch {
        slot = Math.max(nextAt, now());
        nextAt = slot + spacing;
      }
    } else {
      slot = Math.max(nextAt, now());
      nextAt = slot + spacing;
    }
    const delay = slot - now();
    if (delay > 0) await sleep(delay);
  }

  async function run(key, fn, opts = {}) {
    const ttlMs = opts.ttlMs ?? 0;
    const retries = opts.retries ?? maxRetries;
    if (key && ttlMs > 0) {
      const hit = cache.get(key);
      if (hit && hit.expires > now()) return hit.value;
    }
    if (key && inflight.has(key)) return inflight.get(key);

    const job = (async () => {
      let attempt = 0;
      for (;;) {
        await waitTurn();
        try {
          const value = await fn();
          penaltyMs = 500;
          if (key && ttlMs > 0) cache.set(key, { value, expires: now() + ttlMs });
          return value;
        } catch (err) {
          if (!isRateLimitError(err) || attempt >= retries) {
            if (isRateLimitError(err)) throw new RateLimitError(err.message || "429", penaltyMs);
            throw err;
          }
          const wait = err.retryAfterMs || penaltyMs;
          penaltyMs = Math.min(penaltyMs * 2, 4000);
          nextAt = Math.max(nextAt, now() + wait);
          attempt += 1;
          await sleep(wait);
        }
      }
    })();

    if (key) inflight.set(key, job);
    try {
      return await job;
    } finally {
      if (key) inflight.delete(key);
    }
  }

  return { run, spacing, cache };
}

export function rpcKey(method, args) {
  try {
    return `${method}:${JSON.stringify(args, (_key, value) => {
      if (value && typeof value.toBase58 === "function") return value.toBase58();
      if (typeof value === "bigint") return value.toString();
      return value;
    })}`;
  } catch {
    return null;
  }
}

export function defaultMaxPerSec(env = process.env) {
  const parsed = Number(env.RPC_MAX_PER_SEC || 5);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export function cacheTtl(env = process.env, fallback = 3000) {
  const parsed = Number(env.RPC_CACHE_MS || fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function positionPollMs(env = process.env) {
  const parsed = Number(env.POSITION_POLL_MS || 8000);
  return Number.isFinite(parsed) && parsed >= 250 ? parsed : 8000;
}
