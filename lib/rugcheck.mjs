// Reusable rug check for every auto-buy path.
// evaluateRug is pure. collectRugSignals talks to injected readers so tests
// never open a socket. Thresholds come from the environment; see .env.example.
// A rate-limit gap is deferred (never a buy, never a rug). Raw signature-page
// length is not creator history; prior launches and stop-outs are.

import { isRateLimitError } from "./rpc-budget.mjs";

export const DEFAULT_THRESHOLDS = {
  rejectMintAuthority: true,
  rejectFreezeAuthority: true,
  maxTopHolderPct: 20,
  maxDevBuySharePct: 10,
  maxCreatorLaunches: 3,
  maxCreatorRugs: 0,
  maxCreatorSignatures: 0,
  minRealSol: 0.4,
  failClosed: true,
  maxSameSlotBuyers: 6,
  maxCommonFunderPct: 0,
  blockOnUnknown: false,
};

function flag(env, key, fallback) {
  const value = env[key];
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function num(env, key, fallback) {
  const value = env[key];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadThresholds(env = process.env) {
  return {
    rejectMintAuthority: flag(env, "RUG_REJECT_MINT_AUTHORITY", DEFAULT_THRESHOLDS.rejectMintAuthority),
    rejectFreezeAuthority: flag(env, "RUG_REJECT_FREEZE_AUTHORITY", DEFAULT_THRESHOLDS.rejectFreezeAuthority),
    maxTopHolderPct: num(env, "RUG_MAX_TOP_HOLDER_PCT", DEFAULT_THRESHOLDS.maxTopHolderPct),
    maxDevBuySharePct: num(env, "RUG_MAX_DEV_BUY_SHARE_PCT", DEFAULT_THRESHOLDS.maxDevBuySharePct),
    maxCreatorLaunches: num(env, "RUG_MAX_CREATOR_LAUNCHES", DEFAULT_THRESHOLDS.maxCreatorLaunches),
    maxCreatorRugs: num(env, "RUG_MAX_CREATOR_RUGS", DEFAULT_THRESHOLDS.maxCreatorRugs),
    maxCreatorSignatures: num(env, "RUG_MAX_CREATOR_SIGNATURES", DEFAULT_THRESHOLDS.maxCreatorSignatures),
    minRealSol: num(env, "RUG_MIN_REAL_SOL", DEFAULT_THRESHOLDS.minRealSol),
    failClosed: flag(env, "RUG_FAIL_CLOSED", DEFAULT_THRESHOLDS.failClosed),
    maxSameSlotBuyers: num(env, "RUG_MAX_SAME_SLOT_BUYERS", DEFAULT_THRESHOLDS.maxSameSlotBuyers),
    maxCommonFunderPct: num(env, "RUG_MAX_COMMON_FUNDER_PCT", DEFAULT_THRESHOLDS.maxCommonFunderPct),
    blockOnUnknown: flag(env, "RUG_BLOCK_ON_UNKNOWN", DEFAULT_THRESHOLDS.blockOnUnknown),
  };
}

export function formatPct(value) {
  return Number(value).toFixed(2);
}

export function formatSol(value) {
  return Number(value).toFixed(4);
}

// SPL Token and Token-2022 share this 82-byte mint prefix.
export function parseMintAuthorities(data) {
  if (!data) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 82) return null;
  const mintFlag = buf.readUInt32LE(0);
  const freezeFlag = buf.readUInt32LE(46);
  if (mintFlag !== 0 && mintFlag !== 1) return null;
  if (freezeFlag !== 0 && freezeFlag !== 1) return null;
  return {
    mintAuthoritySet: mintFlag === 1,
    freezeAuthoritySet: freezeFlag === 1,
    supply: buf.readBigUInt64LE(36),
    decimals: buf[44],
    initialized: buf[45] === 1,
  };
}

export function sharePct(part, supply) {
  if (part == null || supply == null) return null;
  const owned = BigInt(part);
  const total = BigInt(supply);
  if (total <= 0n) return null;
  return Number((owned * 10000n) / total) / 100;
}

// Largest holder as a percent of total supply, ignoring bonding-curve accounts.
export function topHolderPct(supply, accounts, excludeAddresses = []) {
  if (supply == null) return null;
  const total = BigInt(supply);
  if (total <= 0n) return null;
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const exclude = new Set(excludeAddresses);
  let top = 0n;
  let seen = 0;
  for (const account of accounts) {
    if (!account || exclude.has(account.address)) continue;
    seen += 1;
    const amount = BigInt(account.amount);
    if (amount > top) top = amount;
  }
  if (seen === 0) return 0;
  return sharePct(top, total);
}

export function evaluateRug(signals, thresholds = loadThresholds({})) {
  const reasons = [];
  const notes = [];
  if (!signals || typeof signals !== "object") {
    return { ok: false, deferred: false, reasons: ["rug_data_unavailable: missing_signals"], notes, signals };
  }

  if (signals.rateLimited) {
    return {
      ok: false,
      deferred: true,
      reasons: ["rate_limited_defer"],
      notes: ["rate_limited_not_a_rug"],
      signals,
    };
  }

  if (signals.unavailable && thresholds.failClosed) {
    reasons.push(`rug_data_unavailable: ${signals.unavailable}`);
  } else if (signals.unavailable) {
    notes.push(`rug_data_unavailable_ignored: ${signals.unavailable}`);
  }

  const closed = Boolean(thresholds.failClosed);

  if (signals.mintAuthoritySet == null) {
    if (closed && thresholds.rejectMintAuthority) reasons.push("mint_authority_unknown");
    else notes.push("mint_authority_unknown");
  } else if (signals.mintAuthoritySet && thresholds.rejectMintAuthority) {
    reasons.push("mint_authority_still_set");
  } else if (signals.mintAuthoritySet) {
    notes.push("mint_authority_still_set_allowed");
  } else {
    notes.push("mint_authority_clear");
  }

  if (signals.freezeAuthoritySet == null) {
    if (closed && thresholds.rejectFreezeAuthority) reasons.push("freeze_authority_unknown");
    else notes.push("freeze_authority_unknown");
  } else if (signals.freezeAuthoritySet && thresholds.rejectFreezeAuthority) {
    reasons.push("freeze_authority_still_set");
  } else if (signals.freezeAuthoritySet) {
    notes.push("freeze_authority_still_set_allowed");
  } else {
    notes.push("freeze_authority_clear");
  }

  if (signals.topHolderPct == null) {
    if (closed) reasons.push("top_holder_unknown");
    else notes.push("top_holder_unknown");
  } else if (signals.topHolderPct > thresholds.maxTopHolderPct) {
    reasons.push(`top_holder_pct ${formatPct(signals.topHolderPct)} > ${formatPct(thresholds.maxTopHolderPct)}`);
  } else {
    notes.push(`top_holder_pct ${formatPct(signals.topHolderPct)}`);
  }

  if (signals.devBuySharePct == null) {
    notes.push("dev_buy_share_unknown");
  } else if (signals.devBuySharePct > thresholds.maxDevBuySharePct) {
    reasons.push(`dev_buy_share_pct ${formatPct(signals.devBuySharePct)} > ${formatPct(thresholds.maxDevBuySharePct)}`);
  } else {
    notes.push(`dev_buy_share_pct ${formatPct(signals.devBuySharePct)}`);
  }

  if (signals.creatorLaunches == null) {
    notes.push("creator_launches_unknown");
  } else if (signals.creatorLaunches > thresholds.maxCreatorLaunches) {
    reasons.push(`creator_launches ${signals.creatorLaunches} > ${thresholds.maxCreatorLaunches}`);
  } else {
    notes.push(`creator_launches ${signals.creatorLaunches}`);
  }

  if (signals.creatorRugs == null) {
    notes.push("creator_rugs_unknown");
  } else if (signals.creatorRugs > thresholds.maxCreatorRugs) {
    reasons.push(`creator_rugs ${signals.creatorRugs} > ${thresholds.maxCreatorRugs}`);
  } else {
    notes.push(`creator_rugs ${signals.creatorRugs}`);
  }

  if (signals.creatorSignaturesCapped) {
    notes.push(`creator_signatures_capped_at_${signals.creatorSignatureLimit || "page"}`);
  } else if (thresholds.maxCreatorSignatures > 0 && signals.creatorSignatures != null) {
    if (signals.creatorSignatures > thresholds.maxCreatorSignatures) {
      reasons.push(`creator_signatures ${signals.creatorSignatures} > ${thresholds.maxCreatorSignatures}`);
    } else {
      notes.push(`creator_signatures ${signals.creatorSignatures}`);
    }
  } else {
    notes.push("creator_signatures_off");
  }

  if (signals.realSol == null) {
    if (closed) reasons.push("liquidity_unknown");
    else notes.push("liquidity_unknown");
  } else if (signals.realSol < thresholds.minRealSol) {
    reasons.push(`thin_liquidity_sol ${formatSol(signals.realSol)} < ${formatSol(thresholds.minRealSol)}`);
  } else {
    notes.push(`liquidity_sol ${formatSol(signals.realSol)}`);
  }

  const maxSlot = thresholds.maxSameSlotBuyers ?? 0;
  if (!(maxSlot > 0)) {
    notes.push("same_slot_off");
  } else if (signals.sameSlotBuyers == null) {
    notes.push("same_slot_buyers_unknown");
  } else if (signals.sameSlotBuyers > maxSlot) {
    reasons.push(`bundled_same_slot ${signals.sameSlotBuyers} > ${maxSlot}`);
  } else {
    notes.push(`same_slot_buyers ${signals.sameSlotBuyers}`);
  }

  const maxFunder = thresholds.maxCommonFunderPct ?? 0;
  if (!(maxFunder > 0)) {
    notes.push("common_funder_off");
  } else if (signals.commonFunderPct == null) {
    notes.push("common_funder_unknown");
  } else if (signals.commonFunderPct > maxFunder) {
    reasons.push(`common_funder_pct ${formatPct(signals.commonFunderPct)} > ${formatPct(maxFunder)}`);
  } else {
    notes.push(`common_funder_pct ${formatPct(signals.commonFunderPct)}`);
  }

  if (thresholds.blockOnUnknown) {
    for (const note of notes) {
      if (String(note).endsWith("_unknown")) reasons.push(`unknown_blocks ${note}`);
    }
  }

  return { ok: reasons.length === 0, deferred: false, reasons, notes, signals };
}

// Share of buyers whose first funding account is the same wallet.
// Callers pass a map they already have. This does not fetch transactions.
export function commonFunderPct(buyers) {
  if (!Array.isArray(buyers) || buyers.length === 0) return null;
  if (buyers.some((row) => !row?.funder)) return null;
  const counts = new Map();
  for (const row of buyers) counts.set(row.funder, (counts.get(row.funder) || 0) + 1);
  const top = Math.max(...counts.values());
  return (top / buyers.length) * 100;
}

function emptySignals(input, unavailable) {
  return {
    mintAuthoritySet: null,
    freezeAuthoritySet: null,
    topHolderPct: null,
    devBuySharePct: null,
    creatorLaunches: input?.creatorLaunches ?? null,
    creatorRugs: input?.creatorRugs ?? null,
    creatorSignatures: null,
    creatorSignaturesCapped: false,
    rateLimited: false,
    realSol: null,
    decimals: null,
    supply: null,
    unavailable,
  };
}

export async function collectRugSignals(input, deps) {
  const baseLaunches = input?.creatorLaunches ?? null;
  try {
    const data = await deps.getMintAccount(input.mint);
    const parsed = parseMintAuthorities(data);
    if (!parsed) return emptySignals(input, "mint_account_missing");
    if (!parsed.initialized) {
      return { ...emptySignals(input, "mint_not_initialized"), decimals: parsed.decimals, supply: parsed.supply.toString() };
    }

    const accounts = await deps.getLargestAccounts(input.mint);
    const holderPct = topHolderPct(parsed.supply, accounts, input.excludeAddresses || []);
    let devBuySharePct = input.devBuyTokensRaw == null
      ? null
      : sharePct(input.devBuyTokensRaw, parsed.supply);
    if (devBuySharePct == null && input.creatorAta) {
      const creatorRow = accounts.find((account) => account.address === input.creatorAta);
      if (creatorRow) devBuySharePct = sharePct(creatorRow.amount, parsed.supply);
    }

    let creatorLaunches = baseLaunches;
    let creatorRugs = input.creatorRugs ?? null;
    if ((creatorLaunches == null || creatorRugs == null) && input.creator && deps.readCreatorStats) {
      const known = await deps.readCreatorStats(input.creator);
      if (known) {
        if (creatorLaunches == null) creatorLaunches = known.launches;
        if (creatorRugs == null) creatorRugs = known.rugs;
      }
    }

    let realSolFromInput = input.realSol ?? null;
    if (realSolFromInput == null && deps.getCurveState) {
      const curve = await deps.getCurveState(input.mint);
      if (curve && curve.realSolReserves != null) realSolFromInput = Number(curve.realSolReserves) / 1e9;
    }

    let creatorSignatures = null;
    let creatorSignaturesCapped = false;
    let creatorSignatureLimit = null;
    if (input.creator && deps.getSignatureSample && input.signatureLimit > 0) {
      const sample = await deps.getSignatureSample(input.creator, input.signatureLimit);
      creatorSignatures = sample?.count ?? null;
      creatorSignaturesCapped = Boolean(sample?.capped);
      creatorSignatureLimit = sample?.limit ?? input.signatureLimit;
    }

    return {
      mintAuthoritySet: parsed.mintAuthoritySet,
      freezeAuthoritySet: parsed.freezeAuthoritySet,
      topHolderPct: holderPct,
      devBuySharePct,
      creatorLaunches,
      creatorRugs,
      creatorSignatures,
      creatorSignaturesCapped,
      creatorSignatureLimit,
      realSol: realSolFromInput ?? null,
      decimals: parsed.decimals,
      supply: parsed.supply.toString(),
    };
  } catch (err) {
    if (isRateLimitError(err)) {
      return { ...emptySignals(input, "rate_limited"), rateLimited: true };
    }
    return emptySignals(input, err?.message || "rug_check_failed");
  }
}
