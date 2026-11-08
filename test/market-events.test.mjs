import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { PUMP_PROGRAM, TRADE_EVENT_PREFIX } from "../lib/constants.mjs";
import { eventsFromLogs, tradeSanity } from "../lib/market-events.mjs";

const PUMP = PUMP_PROGRAM.toBase58();

function tradeData({ solLamports, virtualSol = 40_000_000_000n, tokenRaw = 5_000_000n }) {
  const buf = Buffer.alloc(129);
  TRADE_EVENT_PREFIX.copy(buf, 0);
  buf.set(Keypair.generate().publicKey.toBytes(), 8);
  buf.writeBigUInt64LE(BigInt(solLamports), 40);
  buf.writeBigUInt64LE(BigInt(tokenRaw), 48);
  buf[56] = 1;
  buf.set(Keypair.generate().publicKey.toBytes(), 57);
  buf.writeBigUInt64LE(BigInt(virtualSol), 97);
  buf.writeBigUInt64LE(1_000_000_000_000n, 105);
  buf.writeBigUInt64LE(5_000_000_000n, 113);
  return buf.toString("base64");
}

test("a token-sized integer is not counted as SOL volume", () => {
  const huge = 732_500n * 1_000_000_000n;
  const logs = [
    `Program ${PUMP} invoke [1]`,
    "Program log: Instruction: Buy",
    `Program data: ${tradeData({ solLamports: huge, tokenRaw: 1n })}`,
    `Program ${PUMP} success`,
  ];
  const parsed = eventsFromLogs(logs);
  assert.equal(parsed.flagged, 1);
  assert.equal(parsed.events.filter((event) => event.type === "trade").length, 0);
  assert.ok(parsed.events[0].reasons.includes("sol_above_curve_capacity"));
  assert.ok(parsed.events[0].solAmount > 150);
});

test("another program's TradeEvent is not pump volume", () => {
  const huge = 732_500n * 1_000_000_000n;
  const foreign = Keypair.generate().publicKey.toBase58();
  const logs = [
    `Program ${foreign} invoke [1]`,
    "Program log: Instruction: Buy",
    `Program data: ${tradeData({ solLamports: huge })}`,
    `Program ${PUMP} invoke [2]`,
    "Program log: Instruction: Buy",
    `Program data: ${tradeData({ solLamports: 500_000_000n })}`,
    `Program ${PUMP} success`,
    `Program ${foreign} success`,
  ];
  const parsed = eventsFromLogs(logs);
  const trades = parsed.events.filter((event) => event.type === "trade");
  assert.equal(parsed.flagged, 0);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].solAmount, 0.5);
  assert.equal(tradeSanity({ solAmount: 0.5, virtualSol: 40_000_000_000n }).ok, true);
});

test("reserves that are not a bonding curve are dropped", () => {
  const logs = [
    `Program ${PUMP} invoke [1]`,
    "Program log: Instruction: Buy",
    `Program data: ${tradeData({ solLamports: 1_000_000_000n, virtualSol: 732_500n * 1_000_000_000n })}`,
    `Program ${PUMP} success`,
  ];
  const parsed = eventsFromLogs(logs);
  assert.equal(parsed.flagged, 1);
  assert.ok(parsed.events[0].reasons.includes("virtual_sol_implausible"));
  const plausibleSell = eventsFromLogs([
    `Program ${PUMP} invoke [1]`,
    "Program log: Instruction: Sell",
    `Program data: ${tradeData({ solLamports: 20_000_000_000n, virtualSol: 30_000_000_000n })}`,
    `Program ${PUMP} success`,
  ]);
  assert.equal(plausibleSell.flagged, 0);
  assert.equal(plausibleSell.events[0].solAmount, 20);
});
