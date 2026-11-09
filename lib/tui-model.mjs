import fs from "node:fs";
import path from "node:path";
import { BOTS, matchBotProcesses, parseLogSignals, processAlive, readBotStatus, readPid } from "./bot-status.mjs";
import { loadExitConfig } from "./exit-plan.mjs";
import { readOpenPositions } from "./paper-book.mjs";
import { DEFAULT_STOP_RATIO, earlyStopMargin, effectiveStopRatio } from "./positions.mjs";
import { liquidityBucket, readTrades, summarize } from "./trade-log.mjs";

const LOG_NAMES = {
  sniper: "sniper.log",
  "graduation-sniper": "graduation-sniper.log",
  analytics: "analytics.log",
  "copy-trader": "copy-trader.log",
};

const TIMEOUTS = {
  sniper: ["SNIPER_TIMEOUT_SEC", 120],
  "graduation-sniper": ["GRAD_TIMEOUT_SEC", 300],
  "copy-trader": ["COPY_TIMEOUT_SEC", 0],
  analytics: ["ANALYTICS_TIMEOUT_SEC", 0],
};

const STOPS = {
  sniper: ["SNIPER_STOP_LOSS", DEFAULT_STOP_RATIO],
  "graduation-sniper": ["GRAD_STOP_LOSS", DEFAULT_STOP_RATIO],
  "copy-trader": ["COPY_STOP_LOSS", DEFAULT_STOP_RATIO],
};

function num(env, key, fallback) {
  const value = env?.[key];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, missing: true, value: null };
  try {
    return { ok: true, missing: false, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { ok: false, missing: false, value: null };
  }
}

function tradeMultiple(row) {
  const size = Number(row.sizeSol);
  const pnl = Number(row.pnlSol);
  if (!(size > 0) || !Number.isFinite(pnl)) return null;
  return 1 + pnl / size;
}

function ageLimit(pos, exitCfg, timeoutSec) {
  const peak = Number(pos.peakRatio) > 0 ? Number(pos.peakRatio) : (Number(pos.markRatio) > 0 ? Number(pos.markRatio) : 1);
  const trailOn = exitCfg.trailActivateX > 0 && exitCfg.trailPct > 0 && peak >= exitCfg.trailActivateX;
  const inProfit = Number(pos.markRatio) > 1;
  if (exitCfg.extendTimeout && trailOn && inProfit) return Math.max(timeoutSec, exitCfg.maxHoldSec);
  return timeoutSec;
}

export function decoratePosition(pos, env = process.env, now = Date.now()) {
  const exitCfg = loadExitConfig(env);
  const [stopKey, stopFallback] = STOPS[pos.bot] || ["SNIPER_STOP_LOSS", DEFAULT_STOP_RATIO];
  const stop = effectiveStopRatio(num(env, stopKey, stopFallback), earlyStopMargin(env));
  const peak = Number(pos.peakRatio) > 0 ? Number(pos.peakRatio) : (Number(pos.markRatio) > 0 ? Number(pos.markRatio) : 1);
  const trail = exitCfg.trailActivateX > 0 && exitCfg.trailPct > 0 && peak >= exitCfg.trailActivateX
    ? peak * (1 - exitCfg.trailPct)
    : null;
  const [timeoutKey, timeoutFallback] = TIMEOUTS[pos.bot] || ["SNIPER_TIMEOUT_SEC", 120];
  const timeoutSec = num(env, timeoutKey, timeoutFallback);
  const limitSec = ageLimit(pos, exitCfg, timeoutSec);
  const ageSec = Number.isFinite(pos.entryTime) ? Math.max(0, (now - pos.entryTime) / 1000) : null;
  return { ...pos, stopRatio: stop, trailRatio: trail, timeoutSec: limitSec, ageSec };
}

export function readRpcView(file, now = Date.now(), maxPerSec = 5) {
  const parsed = readJson(file);
  if (parsed.missing) return { present: false, waitMs: 0, maxPerSec, error: null };
  if (!parsed.ok || parsed.value?.label !== "RPC_BUDGET") {
    return { present: true, waitMs: null, maxPerSec, error: "unreadable" };
  }
  const nextAt = Number(parsed.value.nextAt) || 0;
  return { present: true, waitMs: Math.max(0, nextAt - now), maxPerSec, error: null, nextAt };
}

export function readPendingApprovals(file, now = Date.now()) {
  const parsed = readJson(file);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  return parsed.value
    .filter((item) => item && item.status === "pending" && item.id)
    .map((item) => ({
      id: String(item.id),
      bot: item.bot || "?",
      mint: item.mint || "",
      amountSol: Number(item.amountSol),
      expiresAt: Number(item.expiresAt) || null,
      ttlSec: item.expiresAt ? Math.max(0, Math.round((item.expiresAt - now) / 1000)) : null,
      command: `node bots/approve.mjs approve ${item.id}`,
    }))
    .sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0));
}

function logFile(logDir, bot) {
  if (!logDir) return null;
  return path.join(logDir, LOG_NAMES[bot] || `${bot}.log`);
}

function readLog(file) {
  if (!file || !fs.existsSync(file)) return { text: "", mtimeMs: null };
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const fd = fs.openSync(file, "r");
    try {
      const take = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, Math.max(0, size - take));
      return { text: buf.toString("utf8"), mtimeMs: stat.mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: "", mtimeMs: null };
  }
}

export function buildSnapshot({
  root,
  logDir = null,
  now = Date.now(),
  env = process.env,
  isAlive = processAlive,
  processes = null,
  analyticsHttp = null,
  staleMs = num(env, "WS_STALE_MS", 45000),
} = {}) {
  const data = path.join(root, "data");
  const trades = readTrades(path.join(data, "trades.jsonl"));
  const summary = summarize(trades);
  const positions = readOpenPositions(path.join(data, "positions")).map((pos) => decoratePosition(pos, env, now));
  const approvals = readPendingApprovals(path.join(data, "approvals.json"), now);
  const rpc = readRpcView(path.join(data, "rpc-budget.json"), now, num(env, "RPC_MAX_PER_SEC", 5));
  const holdsParsed = readJson(path.join(data, "open-mints.json"));
  const holds = holdsParsed.ok && holdsParsed.value?.label === "OPEN_MINTS" && Array.isArray(holdsParsed.value.mints)
    ? holdsParsed.value.mints.filter((row) => row?.mint && row?.bot)
    : [];

  const fromPs = matchBotProcesses(processes);
  const bots = [];
  let anyLive = false;
  let anyDry = false;
  let anyTrader = false;

  for (const bot of BOTS) {
    const status = readBotStatus(path.join(data, "status", `${bot.id}.json`));
    const pidFromFile = readPid(path.join(data, "pids", `${bot.id}.pid`));
    const pid = pidFromFile || status?.pid || fromPs[bot.id] || null;
    const alive = pid ? isAlive(pid) : false;
    const log = readLog(logFile(logDir, bot.id));
    const signals = parseLogSignals(log.text);
    const statusFresh = status && alive && now - Number(status.updatedAt || 0) < 10_000;
    const reconnects = statusFresh ? Number(status.wsReconnects) || 0 : signals.reconnects;
    const lastDataAt = statusFresh && status.wsLastDataAt != null ? Number(status.wsLastDataAt) : log.mtimeMs;
    const lastSource = statusFresh && status.wsLastDataAt != null ? "ws" : (log.mtimeMs ? "log" : null);
    const ageMs = lastDataAt == null ? null : Math.max(0, now - lastDataAt);
    const stale = alive && (ageMs == null ? (status?.startedAt && now - status.startedAt >= staleMs) : ageMs >= staleMs);
    const dryRun = statusFresh ? status.dryRun : (signals.mode === "dry" ? true : signals.mode === "live" ? false : status?.dryRun ?? null);
    if (bot.id !== "analytics" && alive) {
      anyTrader = true;
      if (dryRun === false) anyLive = true;
      if (dryRun === true) anyDry = true;
    }
    bots.push({
      id: bot.id,
      pid: alive ? pid : null,
      alive,
      dryRun: alive ? dryRun : null,
      reconnects,
      lastDataAt,
      lastSource,
      ageMs: alive ? ageMs : null,
      stale: Boolean(stale),
      startedAt: status?.startedAt || null,
    });
  }

  let mode = "unknown";
  if (anyLive) mode = "live";
  else if (anyDry) mode = "dry";
  else if (!anyTrader) {
    const logged = bots.map((bot) => parseLogSignals(readLog(logFile(logDir, bot.id)).text).mode).find((value) => value);
    mode = logged === "live" ? "live" : logged === "dry" ? "dry" : "unknown";
  }

  const closes = trades
    .filter((row) => row.event === "close" || row.event === "partial")
    .sort((a, b) => Number(b.ts) - Number(a.ts))
    .slice(0, 10)
    .map((row) => ({
      ts: Number(row.ts),
      bot: row.bot || "?",
      mint: row.mint || "",
      exitType: row.exitType || "unknown",
      pnlSol: Number(row.pnlSol) || 0,
      multiple: tradeMultiple(row),
      bucket: liquidityBucket(row.entryLiquiditySol),
    }));

  const skips = [...summary.bySkip].sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key))).slice(0, 5);
  const started = bots.filter((bot) => bot.alive && bot.startedAt).map((bot) => bot.startedAt);
  const uptimeMs = started.length ? now - Math.min(...started) : null;

  return {
    now,
    mode,
    uptimeMs,
    bots,
    summary,
    positions,
    closes,
    skips,
    approvals,
    rpc,
    holds: holds.length,
    analyticsHttp,
    staleMs,
  };
}
