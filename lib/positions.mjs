import fs from "node:fs";
import path from "node:path";

// Stop at -6% of the actual fill. 0.94 of fill price, not of the pre-trade curve spot.
// Keep this number aligned with simulation/safety_campaign.py (STOP_RATIO).
export const DEFAULT_STOP_RATIO = 0.94;
export const TOKEN_DECIMALS = 6;

export function spotSolPerToken(virtualSolLamports, virtualTokenRaw, decimals = TOKEN_DECIMALS) {
  const sol = Number(virtualSolLamports) / 1e9;
  const tokens = Number(virtualTokenRaw) / 10 ** decimals;
  if (!(tokens > 0) || !(sol >= 0)) return null;
  return sol / tokens;
}

export function fillPriceSolPerToken(solIn, tokenRaw, decimals = TOKEN_DECIMALS) {
  const tokens = Number(tokenRaw) / 10 ** decimals;
  if (!(Number(solIn) > 0) || !(tokens > 0)) return null;
  return Number(solIn) / tokens;
}

export function priceRatio(mark, fill) {
  if (!(Number(mark) > 0) || !(Number(fill) > 0)) return null;
  return Number(mark) / Number(fill);
}

export function shouldStop(mark, fill, stopRatio = DEFAULT_STOP_RATIO) {
  const ratio = priceRatio(mark, fill);
  if (ratio == null || !(Number(stopRatio) > 0)) return false;
  return ratio <= Number(stopRatio) + 1e-12;
}

export function shouldTakeProfit(mark, fill, takeProfitRatio) {
  const ratio = priceRatio(mark, fill);
  if (ratio == null || !(Number(takeProfitRatio) > 0)) return false;
  return ratio >= Number(takeProfitRatio) - 1e-12;
}

export function evaluateExit({
  mark,
  fillPrice,
  entryTime,
  now = Date.now(),
  stopRatio = DEFAULT_STOP_RATIO,
  takeProfitRatio = null,
  timeoutSec = null,
}) {
  const ratio = priceRatio(mark, fillPrice);
  if (ratio != null && shouldStop(mark, fillPrice, stopRatio)) {
    return { action: "sell", kind: "stop_loss", ratio, reason: `stop-loss ${ratio.toFixed(3)}x of fill` };
  }
  if (ratio != null && takeProfitRatio && shouldTakeProfit(mark, fillPrice, takeProfitRatio)) {
    return { action: "sell", kind: "take_profit", ratio, reason: `take-profit ${ratio.toFixed(3)}x of fill` };
  }
  if (timeoutSec != null && entryTime != null && now - entryTime >= timeoutSec * 1000) {
    const held = ((now - entryTime) / 1000).toFixed(0);
    return { action: "sell", kind: "timeout", ratio, reason: `timeout ${held}s` };
  }
  return { action: "hold", kind: "hold", ratio, reason: null };
}

export function positionFile(root, bot) {
  const safe = String(bot).replace(/[^a-z0-9_-]/gi, "");
  return path.join(root, "data", "positions", `${safe}.json`);
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function savePositions(file, positions) {
  const list = [...positions.values()].map((pos) => ({
    ...pos,
    tokens: pos.tokens == null ? null : String(pos.tokens),
  }));
  atomicWrite(file, `${JSON.stringify({ label: "POSITIONS", positions: list }, null, 2)}\n`);
}

export function loadPositions(file) {
  if (!fs.existsSync(file)) return new Map();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw?.label !== "POSITIONS" || !Array.isArray(raw.positions)) {
    throw new Error(`refusing positions file without POSITIONS label: ${file}`);
  }
  const map = new Map();
  for (const pos of raw.positions) {
    if (!pos?.mint) continue;
    map.set(pos.mint, {
      ...pos,
      fillPrice: Number(pos.fillPrice),
      solIn: Number(pos.solIn),
      entryTime: Number(pos.entryTime),
    });
  }
  return map;
}
