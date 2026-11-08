#!/usr/bin/env node
// Read the local trade journal and print P&L by exit, skip, liquidity, hour, and bot.
//   node bots/analytics/report.mjs [path/to/trades.jsonl]
// Does not open a socket and does not sign.

import path from "node:path";
import { ROOT } from "../../lib/config.mjs";
import { paperSnapshot, readOpenPositions } from "../../lib/paper-book.mjs";
import { readTrades, summarize, tradeLogFile } from "../../lib/trade-log.mjs";

const file = process.argv[2] || tradeLogFile(ROOT);
const summary = summarize(readTrades(file));
const open = readOpenPositions(path.join(ROOT, "data", "positions"));
const paper = paperSnapshot(summary, open);

function line(title, rows, extra = (row) => "") {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log("  (keine)");
    return;
  }
  for (const row of rows) {
    const pnl = Number(row.pnlSol || 0);
    console.log(
      `  ${String(row.key).padEnd(28)} n=${String(row.count).padStart(4)}  ` +
      `wins=${String(row.wins).padStart(4)}  pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL${extra(row)}`,
    );
  }
}

console.log(`Datei: ${file}`);
console.log(
  `Exits ${summary.trades}  Wins ${summary.wins}  Losses ${summary.losses}  ` +
  `Win-Rate ${(summary.winRate * 100).toFixed(1)}%  PnL ${summary.pnlSol >= 0 ? "+" : ""}${summary.pnlSol.toFixed(4)} SOL`,
);
console.log(`Skips ${summary.skips}  Offene Positionen ${paper.openCount} (${paper.openSol.toFixed(4)} SOL)`);
line("Nach Exit", summary.byExit);
line("Nach Skip", summary.bySkip);
line("Nach Liquidität (SOL)", summary.byLiquidity);
line("Nach Stunde (UTC)", summary.byHour);
line("Nach Bot", summary.byBot);
if (paper.open.length) {
  console.log("\nOffene Positionen");
  for (const pos of paper.open) {
    const mark = pos.markRatio == null ? "kein Mark" : `${pos.markRatio.toFixed(3)}x`;
    console.log(`  ${pos.bot}  ${pos.mint}  ${Number(pos.solIn).toFixed(4)} SOL  ${mark}`);
  }
}
