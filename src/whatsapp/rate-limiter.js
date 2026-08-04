// In-memory sliding window. Deliberately not backed by Mongo: the limits exist
// to stop someone spamming the relay in real time, and a process restart
// clearing them is acceptable (and rare).
const WINDOW_MS = 60000;

const hits = new Map(); // key -> number[] of timestamps

function prune(key, now) {
  const times = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (times.length) hits.set(key, times);
  else hits.delete(key);
  return times;
}

/**
 * Record an attempt and report whether it is within the limit.
 * @returns {{allowed: boolean, count: number, limit: number, retryAfterSec: number}}
 */
function take(key, limit) {
  const now = Date.now();
  const times = prune(key, now);

  if (limit > 0 && times.length >= limit) {
    const oldest = times[0];
    return {
      allowed: false,
      count: times.length,
      limit,
      retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
    };
  }

  times.push(now);
  hits.set(key, times);
  return { allowed: true, count: times.length, limit, retryAfterSec: 0 };
}

function reset() {
  hits.clear();
}

module.exports = { take, reset, WINDOW_MS };
