// Plain layout. Color is optional so --once stays copyable text.

const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleLength(text) {
  return String(text).replace(ANSI, "").length;
}

function paint(on, code, text) {
  if (!on) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function clip(text, width) {
  const raw = String(text);
  if (visibleLength(raw) <= width) return raw;
  const plain = raw.replace(ANSI, "");
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

function pad(text, width) {
  const gap = width - visibleLength(text);
  return gap > 0 ? text + " ".repeat(gap) : clip(text, width);
}

function line(text, width) {
  return pad(clip(text, width), width);
}

function sol(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
}

function mult(value) {
  return value == null || !Number.isFinite(Number(value)) ? "  n/a" : `${Number(value).toFixed(2)}x`;
}

function age(sec) {
  if (sec == null || !Number.isFinite(sec)) return "n/a";
  if (sec < 90) return `${Math.round(sec)}s`;
  const min = Math.floor(sec / 60);
  if (min < 90) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

function shortMint(mint) {
  const text = String(mint || "");
  return text.length <= 8 ? text : `${text.slice(0, 8)}..`;
}

function shortExit(kind) {
  const name = String(kind || "");
  if (name === "partial_take_profit") return "partial";
  if (name === "trailing_stop") return "trail";
  if (name === "take_profit") return "takeprofit";
  if (name === "stop_loss") return "stop";
  return name.slice(0, 10);
}

function shortBot(id) {
  if (id === "graduation-sniper") return "grad";
  if (id === "copy-trader") return "copy";
  if (id === "analytics") return "anlyt";
  return id.slice(0, 6);
}

function clock(ts) {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function wsAge(ms) {
  if (ms == null) return "no msg";
  if (ms < 1000) return `${ms}ms`;
  return age(ms / 1000);
}

export function renderSnapshot(model, { width = 80, height = 24, color = false } = {}) {
  const w = Math.max(40, width);
  const h = Math.max(16, height);
  const body = [];
  const push = (text) => body.push(text);

  const mode = model.mode === "live"
    ? paint(color, "1;41;37", " LIVE — NOT DRY RUN ")
    : model.mode === "dry"
      ? paint(color, "1;32", "DRY RUN")
      : paint(color, "33", "MODE UNKNOWN");
  const up = model.uptimeMs == null ? "bots down" : `up ${age(model.uptimeMs / 1000)}`;
  push(`${paint(color, "1", "pump tui")}  ${mode}  ${up}  holds ${model.holds}  q quit`);

  const botBits = model.bots
    .filter((bot) => bot.id !== "copy-trader" || bot.alive)
    .map((bot) => {
      const name = shortBot(bot.id);
      const state = bot.alive ? paint(color, "32", "UP") : paint(color, "2", "down");
      return `${name} ${state}`;
    });
  const http = model.analyticsHttp == null ? "" : model.analyticsHttp ? "  http up" : "  http down";
  push(botBits.join("  ") + http);

  const byBot = model.summary.byBot || [];
  const botPnl = byBot.map((row) => `${shortBot(row.key)} ${sol(row.pnlSol)}`).join("  ") || "no closes";
  const rate = model.summary.trades ? `${Math.round(model.summary.winRate * 100)}%` : "n/a";
  push(`PnL ${sol(model.summary.pnlSol)}  ${model.summary.wins}W/${model.summary.losses}L ${rate}  ${botPnl}`);

  const exitBits = (model.summary.byExit || []).map((row) => `${row.key} ${row.count} ${sol(row.pnlSol)}`).join("  ") || "none";
  const liqBits = (model.summary.byLiquidity || []).map((row) => `${row.key} ${row.count} ${sol(row.pnlSol)}`).join("  ") || "none";
  push(`exit  ${exitBits}`);
  push(`liq   ${liqBits}`);

  const posN = Math.min(model.positions.length, h >= 40 ? 8 : 3);
  const tradeN = h >= 40 ? 10 : 4;

  push(paint(color, "1", "positions  mint      bot    size    mark   stop/trail     age"));
  if (!model.positions.length) push("  none");
  for (const pos of model.positions.slice(0, posN)) {
    const level = pos.trailRatio == null
      ? `stop ${pos.stopRatio.toFixed(2)}`
      : `s${pos.stopRatio.toFixed(2)} t${pos.trailRatio.toFixed(2)}`;
    const mark = pos.markRatio != null && pos.stopRatio != null && pos.markRatio <= pos.stopRatio
      ? paint(color, "31", mult(pos.markRatio))
      : mult(pos.markRatio);
    const timeout = pos.timeoutSec > 0 ? `${age(pos.ageSec)}/${age(pos.timeoutSec)}` : age(pos.ageSec);
    push(`  ${shortMint(pos.mint).padEnd(10)} ${shortBot(pos.bot).padEnd(6)} ${Number(pos.solIn || 0).toFixed(3).padStart(6)}  ${mark}  ${level.padEnd(14)} ${timeout}`);
  }
  if (model.positions.length > posN) push(`  +${model.positions.length - posN} more`);

  push(paint(color, "1", "trades     time      exit        mult    pnl     mint"));
  if (!model.closes.length) push("  none");
  for (const row of model.closes.slice(0, tradeN)) {
    push(`  ${clock(row.ts)}  ${shortExit(row.exitType).padEnd(10)} ${mult(row.multiple)}  ${sol(row.pnlSol)}  ${shortMint(row.mint)}`);
  }

  push(paint(color, "1", "skips"));
  if (!model.skips.length) push("  none");
  for (const row of model.skips.slice(0, h >= 40 ? 5 : 2)) push(`  ${row.count}  ${row.key}`);

  push(paint(color, "1", "approvals  display only"));
  if (!model.approvals.length) push("  none");
  for (const item of model.approvals.slice(0, h >= 40 ? 4 : 1)) {
    push(`  ${item.id} ${shortBot(item.bot)} ${shortMint(item.mint)} ${Number(item.amountSol || 0).toFixed(3)}  ${item.command}`);
  }

  const wsBits = model.bots.filter((bot) => bot.id !== "copy-trader" || bot.alive).map((bot) => {
    const label = `${shortBot(bot.id)} #${bot.reconnects} ${wsAge(bot.ageMs)}${bot.lastSource === "log" ? "*" : ""}`;
    return bot.stale ? paint(color, "31", `${label} STALE`) : label;
  });
  const rpc = model.rpc.error
    ? `rpc  unreadable  cap ${model.rpc.maxPerSec}/s`
    : model.rpc.present
      ? `rpc  next slot ${model.rpc.waitMs}ms  cap ${model.rpc.maxPerSec}/s`
      : `rpc  idle  cap ${model.rpc.maxPerSec}/s`;
  const tail = [`ws  ${wsBits.join("  ")}`, rpc];
  const fitted = [...body.slice(0, Math.max(0, h - tail.length)), ...tail].slice(0, h);
  return fitted.map((text) => line(text, w)).join("\n");
}
