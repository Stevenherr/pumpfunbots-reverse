import fs from "node:fs";
import path from "node:path";

// Local memory of creators this bot has actually seen launch or stop out.
// A full getSignaturesForAddress page is not a launch count and is not stored here.

export function historyFile(root) {
  return path.join(root, "data", "creator-history.json");
}

function empty() {
  return { label: "CREATOR_HISTORY", creators: {} };
}

export function loadCreatorHistory(file) {
  if (!fs.existsSync(file)) return empty();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw?.label !== "CREATOR_HISTORY" || typeof raw.creators !== "object" || raw.creators == null) {
    throw new Error(`refusing creator history without CREATOR_HISTORY label: ${file}`);
  }
  return raw;
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function entry(data, creator) {
  if (!data.creators[creator]) data.creators[creator] = { launches: [], rugs: [] };
  const row = data.creators[creator];
  if (!Array.isArray(row.launches)) row.launches = [];
  if (!Array.isArray(row.rugs)) row.rugs = [];
  return row;
}

// Null when this creator has no saved row. Zero would hide "unknown".
export function creatorStatsKnown(file, creator) {
  if (!creator || !file || !fs.existsSync(file)) return null;
  try {
    const row = loadCreatorHistory(file).creators[creator];
    if (!row) return null;
    return {
      launches: new Set(row.launches || []).size,
      rugs: new Set(row.rugs || []).size,
    };
  } catch {
    return null;
  }
}

export function creatorStats(file, creator) {
  if (!creator) return { launches: 0, rugs: 0 };
  const row = loadCreatorHistory(file).creators[creator];
  if (!row) return { launches: 0, rugs: 0 };
  return {
    launches: new Set(row.launches || []).size,
    rugs: new Set(row.rugs || []).size,
  };
}

export function noteLaunch(file, creator, mint) {
  if (!creator || !mint) return creatorStats(file, creator);
  const data = loadCreatorHistory(file);
  const row = entry(data, creator);
  if (!row.launches.includes(mint)) row.launches.push(mint);
  write(file, data);
  return { launches: new Set(row.launches).size, rugs: new Set(row.rugs).size };
}

export function noteRug(file, creator, mint) {
  if (!creator || !mint) return creatorStats(file, creator);
  const data = loadCreatorHistory(file);
  const row = entry(data, creator);
  if (!row.launches.includes(mint)) row.launches.push(mint);
  if (!row.rugs.includes(mint)) row.rugs.push(mint);
  write(file, data);
  return { launches: new Set(row.launches).size, rugs: new Set(row.rugs).size };
}
