import fs from "node:fs";
import path from "node:path";

// Pure entry gate for the graduation sniper.
// A first print above the fill band only arms a confirmation window.
// A dip during that window skips the buy. A stop-out blocks re-entry.

export function entryDecision({
  now,
  firstTs = null,
  firstSpot = null,
  spot = null,
  fillPct,
  minFillPct = 92,
  confirmSec = 8,
  maxDip = 0.02,
  blocked = false,
  cooldownUntil = 0,
}) {
  if (blocked) return { action: "skip", reason: "reentry_after_stop" };
  if (cooldownUntil && now < cooldownUntil) return { action: "skip", reason: "token_cooldown" };
  if (!(Number(fillPct) >= minFillPct) || Number(fillPct) >= 100) {
    return { action: "ignore", reason: "outside_fill_band" };
  }
  if (firstTs == null || firstSpot == null) return { action: "arm", reason: "confirm_wait" };
  const ageSec = (now - firstTs) / 1000;
  if (ageSec < confirmSec) return { action: "wait", reason: "confirm_wait" };
  if (maxDip > 0 && firstSpot > 0 && spot != null) {
    const dip = (firstSpot - spot) / firstSpot;
    if (dip > maxDip) return { action: "skip", reason: `confirm_dip ${(dip * 100).toFixed(1)}%` };
  }
  return { action: "buy", reason: "confirmed" };
}

export function loadMintBlock(file) {
  const stopped = new Set();
  const cooldown = new Map();
  const seen = new Set();
  if (!fs.existsSync(file)) return { stopped, cooldown, seen };
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw?.label !== "MINT_BLOCK" || !Array.isArray(raw.mints)) {
    throw new Error(`refusing mint block file without MINT_BLOCK label: ${file}`);
  }
  for (const row of raw.mints) {
    if (!row?.mint) continue;
    if (row.stopped) stopped.add(row.mint);
    if (row.seen) seen.add(row.mint);
    if (row.cooldownUntil) cooldown.set(row.mint, Number(row.cooldownUntil));
  }
  return { stopped, cooldown, seen };
}

export function saveMintBlock(file, state) {
  const mints = new Map();
  for (const mint of state.stopped) mints.set(mint, { mint, stopped: true, seen: false, cooldownUntil: 0 });
  for (const mint of state.seen || []) {
    const row = mints.get(mint) || { mint, stopped: false, seen: false, cooldownUntil: 0 };
    row.seen = true;
    mints.set(mint, row);
  }
  for (const [mint, until] of state.cooldown) {
    const row = mints.get(mint) || { mint, stopped: false, seen: false, cooldownUntil: 0 };
    row.cooldownUntil = until;
    if (state.stopped.has(mint)) row.stopped = true;
    mints.set(mint, row);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = {
    label: "MINT_BLOCK",
    mints: [...mints.values()],
  };
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
