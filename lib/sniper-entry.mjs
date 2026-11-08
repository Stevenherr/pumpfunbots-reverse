// A sniper buy is a new launch only. Later trades on the same mint, or a curve
// that already holds a lot of real SOL, are not creates even if a log line
// mentions BondingCurveV3.

export function freshLaunchDecision({
  isCreate = false,
  realSol = null,
  maxRealSol = 12,
  seen = false,
  stopped = false,
  cooldownUntil = 0,
  now = 0,
  heldByOther = false,
}) {
  if (!isCreate) return { action: "ignore", reason: "not_create" };
  if (heldByOther) return { action: "skip", reason: "held_by_other_bot" };
  if (stopped) return { action: "skip", reason: "reentry_after_stop" };
  if (cooldownUntil && now < cooldownUntil) return { action: "skip", reason: "token_cooldown" };
  if (seen) return { action: "skip", reason: "already_seen" };
  if (realSol == null || !Number.isFinite(Number(realSol))) {
    return { action: "skip", reason: "curve_unknown" };
  }
  if (Number(realSol) > maxRealSol) {
    return { action: "skip", reason: `curve_not_fresh ${Number(realSol).toFixed(2)} SOL > ${maxRealSol}` };
  }
  return { action: "buy", reason: "fresh_create" };
}

export function nextHeldMint(mints, cursor = 0) {
  if (!mints.length) return { mint: null, cursor };
  const index = ((cursor % mints.length) + mints.length) % mints.length;
  return { mint: mints[index], cursor: index + 1 };
}
