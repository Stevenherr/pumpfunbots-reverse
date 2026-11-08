import path from "node:path";
import { Connection } from "@solana/web3.js";
import { ROOT, RPC_URL, WS_URL } from "./config.mjs";
import {
  cacheTtl,
  createRpcBudget,
  defaultMaxPerSec,
  reserveSlot,
  rpcKey,
} from "./rpc-budget.mjs";

const maxPerSec = defaultMaxPerSec();
const accountTtl = cacheTtl();
const spacingMs = Math.ceil(1000 / maxPerSec);
const budgetFile = process.env.RPC_BUDGET_FILE || path.join(ROOT, "data", "rpc-budget.json");

export const rpcBudget = createRpcBudget({
  maxPerSec,
  reserve: () => reserveSlot(budgetFile, spacingMs),
});

export const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  wsEndpoint: WS_URL,
  disableRetryOnRateLimit: true,
});

const CACHE_MS = {
  getAccountInfo: accountTtl,
  getMultipleAccountsInfo: accountTtl,
  getTokenLargestAccounts: cacheTtl(process.env, 30000),
  getSignaturesForAddress: 120000,
  getLatestBlockhash: 1500,
};

function wrap(name) {
  const original = connection[name].bind(connection);
  const ttlMs = CACHE_MS[name] ?? 0;
  connection[name] = (...args) => rpcBudget.run(rpcKey(name, args), () => original(...args), { ttlMs });
}

for (const name of [
  "getAccountInfo",
  "getMultipleAccountsInfo",
  "getTokenLargestAccounts",
  "getSignaturesForAddress",
  "getTokenAccountBalance",
  "getLatestBlockhash",
  "getBalance",
  "sendRawTransaction",
  "confirmTransaction",
]) {
  if (typeof connection[name] === "function") wrap(name);
}

export async function sendTxWithRetry(tx, opts = {}) {
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: opts.skipPreflight ?? false,
    maxRetries: opts.maxRetries ?? 3,
    preflightCommitment: "confirmed",
  });
  console.log(`tx sent: ${sig}`);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const result = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err) {
    throw new Error(`tx failed: ${JSON.stringify(result.value.err)}`);
  }
  console.log(`tx confirmed: ${sig}`);
  return sig;
}

export async function getSOLBalance(pubkey) {
  return (await connection.getBalance(pubkey)) / 1e9;
}
