import fs from "node:fs";
import path from "node:path";

// Cross-process claim so the sniper and graduation sniper do not hold one mint.

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lock) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      return fs.openSync(lock, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch { /* gone */ }
      if (Date.now() - start > 2000) throw new Error("held-mints lock timeout");
      sleepMs(15);
    }
  }
}

function release(lock, fd) {
  fs.closeSync(fd);
  try { fs.unlinkSync(lock); } catch { /* gone */ }
}

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw?.label !== "OPEN_MINTS" || !Array.isArray(raw.mints)) {
    throw new Error(`refusing open-mints file without OPEN_MINTS label: ${file}`);
  }
  return raw.mints.filter((row) => row?.mint && row?.bot);
}

function writeRows(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ label: "OPEN_MINTS", mints: rows }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function update(file, mutator) {
  const lock = `${file}.lock`;
  const fd = acquire(lock);
  try {
    const rows = readRows(file);
    const result = mutator(rows);
    writeRows(file, rows);
    return result;
  } finally {
    release(lock, fd);
  }
}

export function heldMintsFile(root) {
  return path.join(root, "data", "open-mints.json");
}

export function heldByOther(file, bot, mint) {
  try {
    const other = readRows(file).find((row) => row.mint === mint && row.bot !== bot);
    return other?.bot || null;
  } catch {
    return null;
  }
}

export function claimHold(file, bot, mint) {
  return update(file, (rows) => {
    const other = rows.find((row) => row.mint === mint && row.bot !== bot);
    if (other) return { ok: false, holder: other.bot };
    if (!rows.some((row) => row.mint === mint && row.bot === bot)) rows.push({ mint, bot });
    return { ok: true, holder: bot };
  });
}

export function releaseHold(file, bot, mint) {
  return update(file, (rows) => {
    const next = rows.filter((row) => !(row.mint === mint && row.bot === bot));
    rows.splice(0, rows.length, ...next);
    return { ok: true };
  });
}
