// A short per-member/per-chat quiet period after a recognized door request.
// It lives in memory for the same reason as rate-limiter.js: this protects the
// real-time relay path, and clearing it on a rare process restart is harmless.
const lastAcceptedAt = new Map();

function durationMs(minutes) {
  const value = Number(minutes);
  return Number.isFinite(value) && value > 0 ? value * 60 * 1000 : 0;
}

function remainingMs(key, minutes, now = Date.now()) {
  const duration = durationMs(minutes);
  if (!duration) return 0;

  const last = lastAcceptedAt.get(key);
  if (!last) return 0;

  const remaining = duration - (now - last);
  if (remaining <= 0) lastAcceptedAt.delete(key);
  return Math.max(0, remaining);
}

function take(key, minutes, now = Date.now()) {
  const remaining = remainingMs(key, minutes, now);
  if (remaining > 0) {
    return { allowed: false, retryAfterSec: Math.ceil(remaining / 1000) };
  }

  if (durationMs(minutes)) lastAcceptedAt.set(key, now);
  return { allowed: true, retryAfterSec: 0 };
}

function reset() {
  lastAcceptedAt.clear();
}

module.exports = { remainingMs, take, reset };
