// Optional post-launch window. ENTRY_CONFIRM_MS=0 keeps the immediate buy.

export function loadEntryConfig(env = process.env) {
  const num = (key, fallback) => {
    const value = env[key];
    if (value == null || value === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    windowMs: num("ENTRY_CONFIRM_MS", 8000),
    minBuyers: num("MIN_UNIQUE_BUYERS", 3),
    minBuySellRatio: num("MIN_BUY_SELL_RATIO", 1.5),
    maxPumpX: num("MAX_PRE_ENTRY_PUMP_X", 1.8),
  };
}

export function confirmEntry({
  elapsedMs = 0,
  windowMs = 0,
  uniqueBuyers = 0,
  buys = 0,
  sells = 0,
  price = null,
  launchPrice = null,
  minBuyers = 3,
  minBuySellRatio = 1.5,
  maxPumpX = 1.8,
} = {}) {
  if (!(windowMs > 0)) return { action: "buy", reason: "confirm_off" };
  if (elapsedMs < windowMs) return { action: "wait", reason: "confirm_wait" };
  const reasons = [];
  if (uniqueBuyers < minBuyers) reasons.push(`buyers ${uniqueBuyers} < ${minBuyers}`);
  const ratio = sells === 0 ? (buys > 0 ? Number.POSITIVE_INFINITY : 0) : buys / sells;
  if (!(ratio >= minBuySellRatio)) {
    const shown = Number.isFinite(ratio) ? ratio.toFixed(2) : "inf";
    reasons.push(`buy_sell_ratio ${shown} < ${minBuySellRatio}`);
  }
  if (launchPrice > 0 && price > 0 && price / launchPrice > maxPumpX) {
    reasons.push(`pre_entry_pump ${(price / launchPrice).toFixed(2)}x > ${maxPumpX}`);
  }
  if (reasons.length) return { action: "skip", reason: reasons.join("; ") };
  return { action: "buy", reason: "confirmed" };
}

export function sameSlotBundle(buyersInSlot, maxBuyers) {
  if (!(maxBuyers > 0) || buyersInSlot == null) {
    return { blocked: false, reason: buyersInSlot == null ? "same_slot_buyers_unknown" : "same_slot_off" };
  }
  if (buyersInSlot > maxBuyers) {
    return { blocked: true, reason: `bundled_same_slot ${buyersInSlot} > ${maxBuyers}` };
  }
  return { blocked: false, reason: `same_slot_buyers ${buyersInSlot}` };
}
