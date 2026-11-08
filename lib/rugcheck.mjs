// Reusable rug check for every auto-buy path.
// evaluateRug is pure. collectRugSignals talks to injected readers so tests
// never open a socket. Thresholds come from the environment; see .env.example.

export const DEFAULT_THRESHOLDS = {
  rejectMintAuthority: true,
  rejectFreezeAuthority: true,
  maxTopHolderPct: 20,
  maxDevBuySharePct: 10,
  maxCreatorLaunches: 3,
  maxCreatorSignatures: 40,
  minRealSol: 0.4,
  failClosed: true,
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
    maxCreatorSignatures: num(env, "RUG_MAX_CREATOR_SIGNATURES", DEFAULT_THRESHOLDS.maxCreatorSignatures),
    minRealSol: num(env, "RUG_MIN_REAL_SOL", DEFAULT_THRESHOLDS.minRealSol),
    failClosed: flag(env, "RUG_FAIL_CLOSED", DEFAULT_THRESHOLDS.failClosed),
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
    return { ok: false, reasons: ["rug_data_unavailable: missing_signals"], notes, signals };
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

  if (signals.creatorSignatures == null) {
    notes.push("creator_signatures_unknown");
  } else if (signals.creatorSignatures > thresholds.maxCreatorSignatures) {
    reasons.push(`creator_signatures ${signals.creatorSignatures} > ${thresholds.maxCreatorSignatures}`);
  } else {
    notes.push(`creator_signatures ${signals.creatorSignatures}`);
  }

  if (signals.realSol == null) {
    if (closed) reasons.push("liquidity_unknown");
    else notes.push("liquidity_unknown");
  } else if (signals.realSol < thresholds.minRealSol) {
    reasons.push(`thin_liquidity_sol ${formatSol(signals.realSol)} < ${formatSol(thresholds.minRealSol)}`);
  } else {
    notes.push(`liquidity_sol ${formatSol(signals.realSol)}`);
  }

  return { ok: reasons.length === 0, reasons, notes, signals };
}

function emptySignals(input, unavailable) {
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
    const devBuySharePct = input.devBuyTokensRaw == null
      ? null
      : sharePct(input.devBuyTokensRaw, parsed.supply);

    let realSol = null;
    if (deps.getCurveState) {
      const curve = await deps.getCurveState(input.mint);
      if (curve && curve.realSolReserves != null) realSol = Number(curve.realSolReserves) / 1e9;
    }

    let creatorSignatures = null;
    if (input.creator && deps.getSignatureCount) {
      creatorSignatures = await deps.getSignatureCount(input.creator);
    }

    return {
      mintAuthoritySet: parsed.mintAuthoritySet,
      freezeAuthoritySet: parsed.freezeAuthoritySet,
      topHolderPct: holderPct,
      devBuySharePct,
      creatorLaunches: baseLaunches,
      creatorSignatures,
      realSol,
      decimals: parsed.decimals,
      supply: parsed.supply.toString(),
    };
  } catch (err) {
    return emptySignals(input, err?.message || "rug_check_failed");
  }
}
