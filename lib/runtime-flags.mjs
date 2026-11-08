export function dryRunFlag(argv = process.argv) {
  return argv.includes("--dry-run");
}

// Fully automatic buys are opt-in. Default is off.
export function autoBuyFlag(argv = process.argv, env = process.env) {
  if (argv.includes("--auto")) return true;
  const value = String(env.AUTO_BUY ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function approvalTtlSec(env = process.env) {
  const parsed = Number(env.APPROVAL_TTL_SEC || 180);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
}

export function stopRatio(envValue, fallback) {
  if (envValue == null || envValue === "") return fallback;
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
