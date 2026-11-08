// BUY_SOL is the ceiling. Scale down until the exit gap at entry fits.
// Skip when even MIN_BUY_SOL is still too large.

export function loadSizeConfig(env = process.env) {
  const num = (key, fallback) => {
    const value = env[key];
    if (value == null || value === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    maxSol: num("SNIPER_BUY_SOL", num("BUY_SOL", 0.1)),
    minSol: num("MIN_BUY_SOL", 0.02),
    maxImpactPct: num("MAX_EXIT_IMPACT_PCT", 5),
  };
}

export function sizeForImpact(probe, { maxSol = 0.1, minSol = 0.02, maxImpactPct = 5 } = {}) {
  const cap = Number(maxSol);
  const floor = Math.min(Number(minSol), cap);
  const limit = Number(maxImpactPct);
  if (!(cap > 0) || !(floor > 0)) return { sol: cap, skip: true, reason: "bad_size_config", impactPct: null };
  const gap = (sol) => {
    const value = probe(sol);
    return value == null ? Number.POSITIVE_INFINITY : Number(value) * 100;
  };
  const atMax = gap(cap);
  if (atMax <= limit) return { sol: cap, skip: false, reason: "max_fits", impactPct: atMax };
  const atMin = gap(floor);
  if (atMin > limit) return { sol: floor, skip: true, reason: "min_buy_still_exceeds_impact", impactPct: atMin };
  let lo = floor;
  let hi = cap;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) <= limit) lo = mid;
    else hi = mid;
  }
  return { sol: lo, skip: false, reason: "scaled", impactPct: gap(lo) };
}
