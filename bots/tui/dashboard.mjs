#!/usr/bin/env node
// Read-only terminal dashboard. It does not sign, approve, or reserve RPC.
//
//   npm run tui
//   node bots/tui/dashboard.mjs --once
//   node bots/tui/dashboard.mjs --log-dir /workspace/dryrun-logs
//
// q or Ctrl-C restores the terminal.

import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../../lib/config.mjs";
import { buildSnapshot } from "../../lib/tui-model.mjs";
import { renderSnapshot } from "../../lib/tui-view.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function listProcesses() {
  try {
    const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
    return out.split("\n").slice(1).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), args: match[2] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function probeAnalytics() {
  if (["1", "true", "yes", "on"].includes(String(process.env.TUI_NO_HTTP || "").toLowerCase())) return null;
  const raw = process.env.TUI_ANALYTICS_URL || "http://127.0.0.1:3000/api/stats";
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 250);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function options() {
  const root = path.resolve(arg("--root", process.env.TUI_ROOT || ROOT));
  const logDir = path.resolve(arg("--log-dir", process.env.TUI_LOG_DIR || path.join(root, "dryrun-logs")));
  const interval = Number(arg("--interval", process.env.TUI_INTERVAL_MS || 1500));
  return {
    root,
    logDir,
    once: process.argv.includes("--once") || !process.stdout.isTTY,
    intervalMs: Number.isFinite(interval) ? Math.min(2000, Math.max(1000, interval)) : 1500,
  };
}

async function snapshot(opts) {
  return buildSnapshot({
    root: opts.root,
    logDir: opts.logDir,
    analyticsHttp: await probeAnalytics(),
    processes: listProcesses(),
  });
}

function restore() {
  if (process.stdin.isTTY && process.stdin.isRaw) {
    try { process.stdin.setRawMode(false); } catch { /* already cooked */ }
  }
  process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
}

async function once(opts) {
  const model = await snapshot(opts);
  process.stdout.write(`${renderSnapshot(model, {
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
    color: false,
  })}\n`);
}

async function loop(opts) {
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  let timer = null;
  let stopped = false;
  const draw = async () => {
    if (stopped) return;
    const model = await snapshot(opts);
    const frame = renderSnapshot(model, {
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
      color: true,
    });
    process.stdout.write(`\x1b[2J\x1b[H${frame}`);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    restore();
    process.exit(0);
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key) => {
    if (key === "q" || key === "Q" || key === "\u0003") stop();
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGWINCH", () => { draw().catch(stop); });
  await draw();
  timer = setInterval(() => { draw().catch(stop); }, opts.intervalMs);
  timer.unref?.();
}

const opts = options();
if (opts.once) {
  once(opts).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  loop(opts).catch((err) => {
    restore();
    console.error(err.message);
    process.exit(1);
  });
}
