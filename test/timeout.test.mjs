import assert from "node:assert/strict";
import test from "node:test";
import { staleExitMark, timeoutDue } from "../lib/positions.mjs";

test("a quiet position times out from the clock, not from a price", () => {
  const timeoutSec = 120;
  const entryTime = 0;
  const pos = { entryTime, fillPrice: 1, lastMark: null };
  assert.equal(timeoutDue(entryTime, 119_000, timeoutSec), false);
  assert.equal(timeoutDue(entryTime, 120_000, timeoutSec), true);

  const closed = [];
  function sweep(now) {
    if (!timeoutDue(pos.entryTime, now, timeoutSec)) return;
    const mark = staleExitMark(pos);
    closed.push({ at: now, price: mark.price, source: mark.source });
  }

  sweep(119_000);
  assert.equal(closed.length, 0);
  sweep(121_000);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].at - (entryTime + timeoutSec * 1000), 1000);
  assert.ok(closed[0].at - (entryTime + timeoutSec * 1000) <= 2000);
  assert.equal(closed[0].price, 1);
  assert.equal(closed[0].source, "entry");
});
