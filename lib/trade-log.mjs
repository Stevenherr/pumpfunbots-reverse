import fs from "node:fs";
import path from "node:path";

export function tradeLogFile(root) {
  return path.join(root, "data", "trades.jsonl");
}

export function appendTrade(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { label: "TRADE", ts: Date.now(), ...record };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return row;
}

export function readTrades(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.label === "TRADE") out.push(row);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

export function liquidityBucket(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n)) return "unknown";
  if (n < 2) return "<2";
  if (n <= 10) return "2-10";
  return ">10";
}

export function summarize(trades) {
  const closes = trades.filter((row) => row.event === "close" || row.event === "partial");
  const skips = trades.filter((row) => row.event === "skip");
  const wins = closes.filter((row) => Number(row.pnlSol) > 0);
  const pnl = closes.reduce((sum, row) => sum + Number(row.pnlSol || 0), 0);
  const by = (rows, keyFn) => {
    const map = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      const cur = map.get(key) || { key, count: 0, pnlSol: 0, wins: 0 };
      cur.count += 1;
      cur.pnlSol += Number(row.pnlSol || 0);
      if (Number(row.pnlSol) > 0) cur.wins += 1;
      map.set(key, cur);
    }
    return [...map.values()];
  };
  return {
    trades: closes.length,
    skips: skips.length,
    wins: wins.length,
    losses: closes.length - wins.length,
    winRate: closes.length ? wins.length / closes.length : 0,
    pnlSol: pnl,
    byExit: by(closes, (row) => row.exitType || "unknown"),
    bySkip: by(skips, (row) => row.skipReason || "unknown"),
    byLiquidity: by(closes, (row) => liquidityBucket(row.entryLiquiditySol)),
    byHour: by(closes, (row) => String(new Date(row.ts).getUTCHours())),
    byBot: by(closes, (row) => row.bot || "unknown"),
  };
}
