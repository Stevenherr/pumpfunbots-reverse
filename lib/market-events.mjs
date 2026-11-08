import { PublicKey } from "@solana/web3.js";
import {
  BUY_INSTRUCTIONS,
  CREATE_INSTRUCTIONS,
  PUMP_PROGRAM,
  SELL_INSTRUCTIONS,
  TRADE_EVENT_PREFIX,
} from "./constants.mjs";

// A pump.fun bonding curve graduates around 85 SOL of real reserves and never
// holds a 732500 SOL trade. Anything above this is a bad parse.
export const MAX_CURVE_SOL = 150;
export const PUMP_PROGRAM_ID = PUMP_PROGRAM.toBase58();

// Leading TradeEvent layout (append-only after this prefix):
// mint, sol lamports, token raw, is_buy, user, timestamp, virtual/real reserves.
export function decodeTradeEvent(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!buf || buf.length < 121 || !buf.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) return null;
  try {
    const solLamports = buf.readBigUInt64LE(40);
    const tokenRaw = buf.readBigUInt64LE(48);
    const virtualSol = buf.readBigUInt64LE(97);
    const virtualToken = buf.readBigUInt64LE(105);
    const realSol = buf.readBigUInt64LE(113);
    return {
      mint: new PublicKey(buf.subarray(8, 40)).toBase58(),
      user: new PublicKey(buf.subarray(57, 89)).toBase58(),
      isBuy: buf[56] === 1,
      solLamports,
      tokenRaw,
      virtualSol,
      virtualToken,
      realSol,
      solAmount: Number(solLamports) / 1e9,
      tokenAmount: Number(tokenRaw) / 1e6,
    };
  } catch {
    return null;
  }
}

export function tradeSanity(trade, { maxCurveSol = MAX_CURVE_SOL } = {}) {
  if (!trade) return { ok: false, reasons: ["unparsed"] };
  const reasons = [];
  const sol = Number(trade.solAmount);
  const virtual = Number(trade.virtualSol) / 1e9;
  if (!(sol > 0) || !Number.isFinite(sol)) reasons.push("sol_not_positive");
  if (sol > maxCurveSol) reasons.push("sol_above_curve_capacity");
  if (!(virtual >= 0.5) || virtual > maxCurveSol || !Number.isFinite(virtual)) {
    reasons.push("virtual_sol_implausible");
  }
  return { ok: reasons.length === 0, reasons, sol, virtualSol: Number.isFinite(virtual) ? virtual : null };
}

function programIdOf(line, verb) {
  const match = line.match(new RegExp(`^Program ([1-9A-HJ-NP-Za-km-z]+) ${verb}`));
  return match ? match[1] : null;
}

// Only Program data emitted inside a pump.fun invoke is a pump trade.
// Other programs reuse the Anchor name TradeEvent and the same 8-byte
// discriminator, with a different body. Those blobs are not volume.
export function eventsFromLogs(logs, { programId = PUMP_PROGRAM_ID, maxCurveSol = MAX_CURVE_SOL } = {}) {
  const stack = [];
  const events = [];
  let flagged = 0;
  let pumpIx = null;
  for (const line of logs || []) {
    const invoked = programIdOf(line, "invoke");
    if (invoked) {
      stack.push(invoked);
      continue;
    }
    if (programIdOf(line, "success") || programIdOf(line, "failed")) {
      stack.pop();
      if (stack.at(-1) !== programId) pumpIx = null;
      continue;
    }
    const ix = line.match(/Program log: Instruction: (\w+)/);
    if (ix && stack.at(-1) === programId) pumpIx = ix[1];
    if (!line.startsWith("Program data: ") || stack.at(-1) !== programId) continue;
    let raw;
    try {
      raw = Buffer.from(line.slice("Program data: ".length).trim(), "base64");
    } catch {
      continue;
    }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    const trade = decodeTradeEvent(raw);
    const sanity = tradeSanity(trade, { maxCurveSol });
    if (!trade || !sanity.ok) {
      flagged += 1;
      events.push({
        type: "flagged",
        mint: trade?.mint || null,
        user: trade?.user || null,
        solAmount: trade?.solAmount ?? null,
        reasons: sanity.reasons,
      });
      continue;
    }
    const isSell = SELL_INSTRUCTIONS.has(pumpIx);
    const isBuy = BUY_INSTRUCTIONS.has(pumpIx) || (trade.isBuy && !isSell);
    events.push({
      type: "trade",
      mint: trade.mint,
      user: trade.user,
      solAmount: sanity.sol,
      tokenAmount: trade.tokenAmount,
      isBuy: isBuy && !isSell,
      virtualSol: sanity.virtualSol,
      realSol: Number(trade.realSol) / 1e9,
    });
    if (CREATE_INSTRUCTIONS.has(pumpIx)) {
      events.push({ type: "create", mint: trade.mint, creator: trade.user, ts: Date.now() });
    }
  }
  return { events, flagged };
}
