// Partial take-profit, trailing stop, hard stop, and wall-clock timeout.
// Ratios are expected sell quote divided by entry fill. Set partialTpPct=0 and
// trailActivateX=0 to get the previous full-exit behavior.

export function loadExitConfig(env = process.env) {
  const num = (key, fallback) => {
    const value = env[key];
    if (value == null || value === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const flag = String(env.TRAIL_EXTEND_TIMEOUT ?? "1").trim().toLowerCase();
  return {
    partialTpPct: num("PARTIAL_TP_PCT", 50),
    partialTpX: num("PARTIAL_TP_X", 1.3),
    trailActivateX: num("TRAIL_ACTIVATE_X", 1.15),
    trailPct: num("TRAIL_PCT", 0.08),
    extendTimeout: !["0", "false", "no", "off"].includes(flag),
    maxHoldSec: num("MAX_HOLD_SEC", 600),
  };
}

export function planExit({
  ratio = null,
  now = 0,
  entryTime = null,
  stopRatio = 0.94,
  fullTpX = 2,
  timeoutSec = 120,
  partialDone = false,
  peakRatio = 1,
  partialTpPct = 50,
  partialTpX = 1.3,
  trailActivateX = 1.15,
  trailPct = 0.08,
  extendTimeout = true,
  maxHoldSec = 600,
} = {}) {
  let peak = Number(peakRatio) > 0 ? Number(peakRatio) : 1;
  if (ratio != null && ratio > peak) peak = ratio;
  const done = Boolean(partialDone);
  const base = {
    peakRatio: peak,
    partialDone: done,
    sellPct: 0,
    timeoutExtended: false,
  };
  if (ratio != null && ratio <= stopRatio) {
    return { ...base, action: "sell", kind: "stop_loss", sellPct: 100, reason: `stop-loss ${ratio.toFixed(3)}x of expected fill` };
  }
  if (fullTpX > 0 && ratio != null && ratio >= fullTpX) {
    return { ...base, action: "sell", kind: "take_profit", sellPct: 100, reason: `take-profit ${ratio.toFixed(3)}x` };
  }
  if (partialTpPct > 0 && !done && ratio != null && ratio >= partialTpX) {
    return {
      ...base,
      action: "sell",
      kind: "partial_take_profit",
      sellPct: partialTpPct,
      partialDone: true,
      reason: `partial-tp ${ratio.toFixed(3)}x sell ${partialTpPct}%`,
    };
  }
  const trailOn = trailActivateX > 0 && trailPct > 0 && peak >= trailActivateX;
  if (trailOn && ratio != null && ratio <= peak * (1 - trailPct)) {
    return { ...base, action: "sell", kind: "trailing_stop", sellPct: 100, reason: `trail-stop ${ratio.toFixed(3)}x peak ${peak.toFixed(3)}x` };
  }
  const inProfit = ratio != null && ratio > 1;
  const extend = Boolean(extendTimeout) && trailOn && inProfit;
  const limit = extend ? Math.max(timeoutSec, maxHoldSec) : timeoutSec;
  if (limit > 0 && entryTime != null && now - entryTime >= limit * 1000) {
    const held = ((now - entryTime) / 1000).toFixed(0);
    return {
      ...base,
      action: "sell",
      kind: "timeout",
      sellPct: 100,
      timeoutExtended: extend,
      reason: `timeout ${held}s`,
    };
  }
  return { ...base, action: "hold", kind: "hold", reason: null, timeoutExtended: extend };
}
