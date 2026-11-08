import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import test from "node:test";
import WebSocket from "ws";
import { TRADE_EVENT_PREFIX } from "../lib/constants.mjs";
import { forEachTradeMark, parseTradeReserves } from "../lib/trade-event.mjs";
import { SolanaWs } from "../lib/ws.mjs";

test("trade reserves are readable from a V3 program-data line", () => {
  const mint = Keypair.generate().publicKey;
  const buf = Buffer.alloc(129);
  TRADE_EVENT_PREFIX.copy(buf, 0);
  buf.set(mint.toBytes(), 8);
  buf.writeBigUInt64LE(1_500_000_000n, 40);
  buf.writeBigUInt64LE(2_500_000n, 48);
  buf.writeBigUInt64LE(40_000_000_000n, 97);
  buf.writeBigUInt64LE(1_000_000_000_000n, 105);
  buf.writeBigUInt64LE(3_000_000_000n, 113);

  const parsed = parseTradeReserves(buf);
  assert.equal(parsed.mint, mint.toBase58());
  assert.equal(parsed.virtualSolReserves, 40_000_000_000n);
  assert.equal(parsed.realSolReserves, 3_000_000_000n);
  assert.equal(parseTradeReserves(Buffer.alloc(20)), null);

  const seen = [];
  forEachTradeMark([`Program data: ${buf.toString("base64")}`, "Program data: @@@"], (mark) => seen.push(mark.mint));
  assert.deepEqual(seen, [mint.toBase58()]);
});

test("ws is a direct dependency and the helper constructs without connecting", () => {
  assert.equal(typeof WebSocket, "function");
  const client = new SolanaWs("ws://127.0.0.1:9");
  assert.equal(client.ws, null);
});
