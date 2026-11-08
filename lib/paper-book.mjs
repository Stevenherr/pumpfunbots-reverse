import fs from "node:fs";
import path from "node:path";

export function readOpenPositions(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (raw?.label !== "POSITIONS" || !Array.isArray(raw.positions)) continue;
    const bot = name.replace(/\.json$/, "");
    for (const pos of raw.positions) {
      if (!pos?.mint) continue;
      const fill = Number(pos.fillPrice);
      const mark = pos.lastMark == null ? null : Number(pos.lastMark);
      out.push({
        bot,
        mint: pos.mint,
        solIn: Number(pos.solIn),
        entryTime: Number(pos.entryTime),
        fillPrice: fill,
        lastMark: Number.isFinite(mark) ? mark : null,
        markRatio: fill > 0 && mark > 0 ? mark / fill : null,
        partialDone: Boolean(pos.partialDone),
        entryLiquiditySol: pos.entryLiquiditySol ?? null,
        peakRatio: pos.peakRatio ?? null,
      });
    }
  }
  return out;
}

export function paperSnapshot(summary, positions) {
  const openSol = positions.reduce((sum, pos) => sum + (Number(pos.solIn) || 0), 0);
  return {
    pnlSol: summary?.pnlSol || 0,
    trades: summary?.trades || 0,
    wins: summary?.wins || 0,
    losses: summary?.losses || 0,
    winRate: summary?.winRate || 0,
    byBot: summary?.byBot || [],
    byExit: summary?.byExit || [],
    openCount: positions.length,
    openSol,
    open: positions,
  };
}
