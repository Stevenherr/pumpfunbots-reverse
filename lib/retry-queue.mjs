// In-memory retries for a rate-limit defer. Missing data is never treated as a buy.

export function createRetryQueue({ maxAttempts = 3 } = {}) {
  const items = [];

  function push(key, delayMs, fn, now = Date.now()) {
    const existing = items.find((item) => item.key === key);
    if (existing) {
      if (existing.attempts >= maxAttempts) return false;
      existing.attempts += 1;
      existing.at = now + delayMs;
      existing.fn = fn;
      return true;
    }
    items.push({ key, attempts: 1, at: now + delayMs, fn });
    return true;
  }

  async function drain(now = Date.now()) {
    const due = items.filter((item) => item.at <= now);
    for (const item of due) {
      const index = items.indexOf(item);
      if (index >= 0) items.splice(index, 1);
      await item.fn(item.attempts);
    }
    return due.length;
  }

  return {
    push,
    drain,
    size: () => items.length,
  };
}
