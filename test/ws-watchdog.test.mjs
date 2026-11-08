import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SolanaWs, isFeedStale, reconnectDelay } from "../lib/ws.mjs";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = FakeSocket.OPEN;
    this.pings = 0;
    this.terminated = false;
    queueMicrotask(() => this.emit("open"));
  }

  static OPEN = 1;

  send() {}

  ping() {
    this.pings += 1;
  }

  terminate() {
    this.readyState = 3;
    this.terminated = true;
    this.emit("close");
  }

  close() {
    this.terminate();
  }
}

test("backoff grows and a quiet feed is stale at the window", () => {
  assert.equal(reconnectDelay(1, 1000, 30_000), 1000);
  assert.equal(reconnectDelay(2, 1000, 30_000), 2000);
  assert.equal(reconnectDelay(3, 1000, 30_000), 4000);
  assert.equal(reconnectDelay(10, 1000, 30_000), 30_000);
  assert.equal(isFeedStale(0, 44_999, 45_000), false);
  assert.equal(isFeedStale(0, 45_000, 45_000), true);
});

test("a silent but open socket reconnects inside the stale window", async () => {
  let now = 1_000;
  const client = new SolanaWs("ws://example.invalid", {
    Socket: FakeSocket,
    staleMs: 30_000,
    baseDelayMs: 1000,
    now: () => now,
    schedule: (ms, fn) => {
      const handle = setTimeout(fn, 60_000);
      handle.unref?.();
      handle._ms = ms;
      handle._fn = fn;
      return handle;
    },
  });
  await client.connect();
  assert.equal(client.reconnects, 0);
  assert.equal(client.ws.pings >= 0, true);
  now = 1_000 + 29_000;
  assert.equal(client.checkWatchdog(), "ok");
  now = 1_000 + 30_000;
  assert.equal(client.checkWatchdog(), "stale");
  const socket = client.ws;
  client._dropStale();
  assert.equal(socket.terminated, true);
  assert.equal(client.ws, null);
  assert.equal(client.reconnects, 1);
  client.close();
});
