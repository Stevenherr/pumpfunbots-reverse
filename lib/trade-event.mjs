import { PublicKey } from "@solana/web3.js";
import { TRADE_EVENT_PREFIX } from "./constants.mjs";

// V3 trade event reserves, used to mark open positions off the existing log stream.
export function forEachTradeMark(logs, visit) {
  if (!logs) return;
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    try {
      const parsed = parseTradeReserves(Buffer.from(line.slice(14), "base64"));
      if (parsed) visit(parsed);
    } catch {
      // malformed program data does not affect other marks
    }
  }
}

export function parseTradeReserves(raw) {
  if (!raw || raw.length < 113) return null;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!buf.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) return null;
  try {
    return {
      mint: new PublicKey(buf.subarray(8, 40)).toBase58(),
      solAmountRaw: buf.readBigUInt64LE(40),
      tokenAmountRaw: buf.readBigUInt64LE(48),
      virtualSolReserves: buf.readBigUInt64LE(97),
      virtualTokenReserves: buf.readBigUInt64LE(105),
      realSolReserves: buf.length >= 121 ? buf.readBigUInt64LE(113) : null,
    };
  } catch {
    return null;
  }
}
