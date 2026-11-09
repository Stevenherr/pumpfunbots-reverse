import fs from "node:fs";
import path from "node:path";

// Local heartbeat. The TUI reads these files and never reserves an RPC slot.

export const BOTS = [
  { id: "sniper", match: /bots\/sniper\/sniper\.mjs/ },
  { id: "graduation-sniper", match: /bots\/graduation-sniper\/graduation\.mjs/ },
  { id: "analytics", match: /bots\/analytics\/server\.mjs/ },
  { id: "copy-trader", match: /bots\/copy-trader\/watcher\.mjs/ },
];

export function pidFile(root, bot) {
  return path.join(root, "data", "pids", `${safe(bot)}.pid`);
}

export function statusFile(root, bot) {
  return path.join(root, "data", "status", `${safe(bot)}.json`);
}

function safe(bot) {
  return String(bot).replace(/[^a-z0-9_-]/gi, "");
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeBotStatus(root, bot, fields = {}) {
  const pid = Number(fields.pid) > 0 ? Number(fields.pid) : process.pid;
  atomicWrite(pidFile(root, bot), `${pid}\n`);
  const body = {
    label: "BOT_STATUS",
    bot,
    pid,
    startedAt: Number(fields.startedAt) || Date.now(),
    dryRun: fields.dryRun == null ? null : Boolean(fields.dryRun),
    autoBuy: Boolean(fields.autoBuy),
    updatedAt: Date.now(),
    wsReconnects: Number(fields.wsReconnects) || 0,
    wsLastDataAt: fields.wsLastDataAt == null ? null : Number(fields.wsLastDataAt),
  };
  atomicWrite(statusFile(root, bot), `${JSON.stringify(body)}\n`);
  return body;
}

export function clearBotStatus(root, bot) {
  for (const file of [pidFile(root, bot), statusFile(root, bot)]) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

export function attachBotStatus(root, bot, read) {
  const startedAt = Date.now();
  let closed = false;
  const publish = () => {
    if (closed) return;
    try {
      writeBotStatus(root, bot, { startedAt, ...(read() || {}) });
    } catch {
      // a full disk must not stop the bot
    }
  };
  publish();
  const timer = setInterval(publish, 1000);
  timer.unref?.();
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try { clearBotStatus(root, bot); } catch { /* ignore */ }
  };
  process.on("exit", stop);
  return { publish, stop };
}

export function readBotStatus(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.label !== "BOT_STATUS") return null;
    return raw;
  } catch {
    return null;
  }
}

export function readPid(file) {
  if (!file || !fs.existsSync(file)) return null;
  const n = Number(String(fs.readFileSync(file, "utf8")).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function matchBotProcesses(rows) {
  const found = {};
  for (const bot of BOTS) found[bot.id] = null;
  for (const row of rows || []) {
    const args = String(row.args || "");
    const pid = Number(row.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    for (const bot of BOTS) {
      if (bot.match.test(args)) found[bot.id] = pid;
    }
  }
  return found;
}

export function parseLogSignals(text) {
  let reconnects = 0;
  let mode = null;
  for (const line of String(text || "").split("\n")) {
    const rec = line.match(/reconnect #(\d+)/);
    if (rec) reconnects = Math.max(reconnects, Number(rec[1]));
    if (line.includes("MODE: DRY RUN")) mode = "dry";
    else if (line.includes("MODE: AUTO_BUY") || line.includes("MODE: approval required")) mode = "live";
  }
  return { reconnects, mode };
}
