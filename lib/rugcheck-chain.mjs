import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ROOT } from "./config.mjs";
import { TOKEN_2022_PROGRAM } from "./constants.mjs";
import { creatorStatsKnown, historyFile } from "./creator-history.mjs";
import { getBondingCurve, getBondingCurveATA } from "./pumpfun.mjs";
import { connection } from "./rpc.mjs";
import { collectRugSignals } from "./rugcheck.mjs";
import { interpretSignatureSample } from "./rpc-budget.mjs";

const SIGNATURE_PAGE = 100;

// Live readers. One mint+curve fetch when liquidity is not already on the trade event.
// Signature pages are off unless RUG_MAX_CREATOR_SIGNATURES is set, and a full page is "capped", not a count.
export async function collectChainRugSignals(input) {
  const signatureLimit = Number(input.signatureLimit ?? process.env.RUG_MAX_CREATOR_SIGNATURES ?? 0);
  try {
    const mintPk = new PublicKey(input.mint);
    const curvePk = getBondingCurve(mintPk);
    const curveAta = getBondingCurveATA(curvePk, mintPk);
    const exclude = new Set([
      curvePk.toBase58(),
      curveAta.toBase58(),
      ...(input.excludeAddresses || []),
    ]);
    let creatorAta = input.creatorAta || null;
    if (!creatorAta && input.creator) {
      try {
        creatorAta = getAssociatedTokenAddressSync(
          mintPk,
          new PublicKey(input.creator),
          false,
          TOKEN_2022_PROGRAM,
        ).toBase58();
      } catch {
        creatorAta = null;
      }
    }
    return await collectRugSignals(
      { ...input, creatorAta, excludeAddresses: [...exclude], signatureLimit },
      {
        getMintAccount: async (mint) => {
          if (input.realSol != null) {
            const info = await connection.getAccountInfo(new PublicKey(mint));
            return info?.data ? Buffer.from(info.data) : null;
          }
          const infos = await connection.getMultipleAccountsInfo([new PublicKey(mint), curvePk]);
          input._curveInfo = infos?.[1] || null;
          return infos?.[0]?.data ? Buffer.from(infos[0].data) : null;
        },
        getLargestAccounts: async (mint) => {
          const res = await connection.getTokenLargestAccounts(new PublicKey(mint));
          return res.value.map((account) => ({
            address: account.address.toBase58(),
            amount: account.amount,
          }));
        },
        getCurveState: async () => {
          if (input.realSol != null) return null;
          const info = input._curveInfo || await connection.getAccountInfo(curvePk);
          if (!info?.data || info.data.length < 73) return null;
          const data = Buffer.from(info.data);
          return { realSolReserves: data.readBigUInt64LE(32) };
        },
        getSignatureSample: async (creator, limit) => {
          const page = Math.min(SIGNATURE_PAGE, Math.max(1, Number(limit) || SIGNATURE_PAGE));
          const sigs = await connection.getSignaturesForAddress(new PublicKey(creator), { limit: page });
          return interpretSignatureSample(sigs.length, page);
        },
        readCreatorStats: async (creator) => creatorStatsKnown(historyFile(ROOT), creator),
      },
    );
  } catch (err) {
    const rateLimited = /429|too many requests|rate limit/i.test(err?.message || "") || err?.rateLimited;
    return {
      mintAuthoritySet: null,
      freezeAuthoritySet: null,
      topHolderPct: null,
      devBuySharePct: null,
      creatorLaunches: input?.creatorLaunches ?? null,
      creatorRugs: input?.creatorRugs ?? null,
      creatorSignatures: null,
      creatorSignaturesCapped: false,
      realSol: input?.realSol ?? null,
      decimals: null,
      supply: null,
      rateLimited,
      unavailable: rateLimited ? "rate_limited" : (err?.message || "rug_check_failed"),
    };
  }
}
