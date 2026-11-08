import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ATA_PROGRAM,
  PUMP_EVENT_AUTH,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  WSOL,
} from "./constants.mjs";
import { connection } from "./rpc.mjs";

// pump.fun bonding curve PDA
export function getBondingCurve(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM,
  )[0];
}

// Associated bonding curve token account (Token-2022)
export function getBondingCurveATA(bondingCurve, mint) {
  return getAssociatedTokenAddressSync(mint, bondingCurve, true, TOKEN_2022_PROGRAM);
}

// Fetch bonding curve state
export async function getBondingCurveState(mint) {
  const bc = getBondingCurve(mint);
  const info = await connection.getAccountInfo(bc);
  if (!info || info.data.length < 73) return null;
  const d = info.data;
  // offset 8: discriminator already skipped by anchor
  // Layout: virtualTokenReserves (u64), virtualSolReserves (u64), realTokenReserves (u64), realSolReserves (u64), tokenTotalSupply (u64), complete (bool)
  return {
    address: bc,
    virtualTokenReserves: d.readBigUInt64LE(8),
    virtualSolReserves: d.readBigUInt64LE(16),
    realTokenReserves: d.readBigUInt64LE(24),
    realSolReserves: d.readBigUInt64LE(32),
    tokenTotalSupply: d.readBigUInt64LE(40),
    complete: d[48] === 1,
  };
}

// Calculate price (SOL per token)
export function getPrice(state) {
  return Number(state.virtualSolReserves) / Number(state.virtualTokenReserves);
}

// Calculate tokens received for a given SOL amount (buy)
export function calcBuyTokens(state, solAmount) {
  const solLamports = BigInt(Math.floor(solAmount * 1e9));
  const fee = solLamports / 100n; // 1% fee
  const netSol = solLamports - fee;
  const tokens =
    (state.virtualTokenReserves * netSol) / (state.virtualSolReserves + netSol);
  return tokens;
}

// Calculate SOL received for a given token amount (sell)
export function calcSellSol(state, tokenAmount) {
  const sol =
    (state.virtualSolReserves * tokenAmount) / (state.virtualTokenReserves + tokenAmount);
  const fee = sol / 100n; // 1% fee
  return sol - fee;
}

// Curve after our buy, using the same 1% fee as calcBuyTokens.
export function curveAfterBuy(state, solAmount) {
  const solLamports = BigInt(Math.floor(Number(solAmount) * 1e9));
  const netSol = solLamports - solLamports / 100n;
  const tokens = (state.virtualTokenReserves * netSol) / (state.virtualSolReserves + netSol);
  return {
    tokens,
    virtualSolReserves: state.virtualSolReserves + netSol,
    virtualTokenReserves: state.virtualTokenReserves - tokens,
  };
}

// How far the price we would actually receive for our new bag sits below the spot
// printed after the buy. A round trip of our own SOL mostly loses the two 1% fees;
// the gap versus spot is the size impact.
export function exitImpactOfBuy(state, solAmount, decimals = 6) {
  const solIn = Number(solAmount);
  if (!(solIn > 0) || state.virtualTokenReserves <= 0n || state.virtualSolReserves <= 0n) return null;
  const after = curveAfterBuy(state, solIn);
  if (after.tokens <= 0n || after.virtualTokenReserves <= 0n) return null;
  const outSol = Number(calcSellSol(after, after.tokens)) / 1e9;
  const expected = outSol / (Number(after.tokens) / 10 ** decimals);
  const postSpot = (Number(after.virtualSolReserves) / 1e9) / (Number(after.virtualTokenReserves) / 10 ** decimals);
  if (!(postSpot > 0) || !(expected > 0)) return null;
  return {
    tokens: after.tokens,
    outSol,
    lossPct: (solIn - outSol) / solIn,
    spotGapPct: (postSpot - expected) / postSpot,
    expected,
    postSpot,
  };
}

// SOL per UI token we would receive by selling tokenRaw on this curve, after the 1% fee.
export function expectedSellPrice(state, tokenRaw, decimals = 6) {
  const raw = BigInt(tokenRaw);
  if (raw <= 0n || state.virtualTokenReserves <= 0n) return null;
  const outSol = Number(calcSellSol(state, raw)) / 1e9;
  const ui = Number(raw) / 10 ** decimals;
  if (!(ui > 0)) return null;
  return outSol / ui;
}

// BuyV2 instruction
export function buyIx(user, mint, solAmount, minTokens) {
  const bc = getBondingCurve(mint);
  const bcAta = getBondingCurveATA(bc, mint);
  const userAta = getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM);

  // Discriminator for BuyV2: sha256("global:buy_v2")[0..8]
  const disc = Buffer.from("d78f037c39e9b3b6", "hex");
  const data = Buffer.alloc(8 + 8 + 8);
  disc.copy(data, 0);
  data.writeBigUInt64LE(minTokens, 8);
  data.writeBigUInt64LE(BigInt(Math.floor(solAmount * 1e9)), 16);

  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bc, isSigner: false, isWritable: true },
      { pubkey: bcAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTH, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// SellV2 instruction
export function sellIx(user, mint, tokenAmount, minSol) {
  const bc = getBondingCurve(mint);
  const bcAta = getBondingCurveATA(bc, mint);
  const userAta = getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM);

  const disc = Buffer.from("33e685a4017f83ad", "hex");
  const data = Buffer.alloc(8 + 8 + 8);
  disc.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(minSol, 16);

  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bc, isSigner: false, isWritable: true },
      { pubkey: bcAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTH, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}
