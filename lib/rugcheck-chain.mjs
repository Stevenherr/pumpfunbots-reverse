import { PublicKey } from "@solana/web3.js";
import { getBondingCurve, getBondingCurveATA, getBondingCurveState } from "./pumpfun.mjs";
import { connection } from "./rpc.mjs";
import { collectRugSignals } from "./rugcheck.mjs";

// Live readers. Imported only by the buy bots. Tests use collectRugSignals directly.
export async function collectChainRugSignals(input) {
  try {
    const mintPk = new PublicKey(input.mint);
    const curve = getBondingCurve(mintPk);
    const curveAta = getBondingCurveATA(curve, mintPk);
    const exclude = new Set([
      curve.toBase58(),
      curveAta.toBase58(),
      ...(input.excludeAddresses || []),
    ]);
    return await collectRugSignals(
      { ...input, excludeAddresses: [...exclude] },
      {
        getMintAccount: async (mint) => {
          const info = await connection.getAccountInfo(new PublicKey(mint));
          return info?.data ? Buffer.from(info.data) : null;
        },
        getLargestAccounts: async (mint) => {
          const res = await connection.getTokenLargestAccounts(new PublicKey(mint));
          return res.value.map((account) => ({
            address: account.address.toBase58(),
            amount: account.amount,
          }));
        },
        getCurveState: async (mint) => getBondingCurveState(new PublicKey(mint)),
        getSignatureCount: async (creator) => {
          const sigs = await connection.getSignaturesForAddress(new PublicKey(creator), { limit: 100 });
          return sigs.length;
        },
      },
    );
  } catch (err) {
    return {
      mintAuthoritySet: null,
      freezeAuthoritySet: null,
      topHolderPct: null,
      devBuySharePct: null,
      creatorLaunches: input?.creatorLaunches ?? null,
      creatorSignatures: null,
      realSol: null,
      decimals: null,
      supply: null,
      unavailable: err?.message || "rug_check_failed",
    };
  }
}
