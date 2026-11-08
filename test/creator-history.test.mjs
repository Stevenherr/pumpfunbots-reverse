import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { creatorStats, noteLaunch, noteRug } from "../lib/creator-history.mjs";

test("launches and rugs are counted once per mint", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "creators-")), "history.json");
  assert.deepEqual(noteLaunch(file, "Creator", "MintA"), { launches: 1, rugs: 0 });
  assert.deepEqual(noteLaunch(file, "Creator", "MintA"), { launches: 1, rugs: 0 });
  assert.deepEqual(noteLaunch(file, "Creator", "MintB"), { launches: 2, rugs: 0 });
  assert.deepEqual(noteRug(file, "Creator", "MintA"), { launches: 2, rugs: 1 });
  assert.deepEqual(noteRug(file, "Creator", "MintA"), { launches: 2, rugs: 1 });
  assert.deepEqual(creatorStats(file, "Creator"), { launches: 2, rugs: 1 });
  assert.deepEqual(creatorStats(file, "Nobody"), { launches: 0, rugs: 0 });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /CREATOR_HISTORY/);
  assert.doesNotMatch(text, /secret|keypair/i);
});
