const crypto = require('crypto');
const { config } = require('../config');

const COOKIE_NAME = 'mindsept_admin';

// Login attempt throttling, keyed by IP. Same sliding-window idea as the door
// rate limiter, but tuned for password guessing.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function tooManyLoginAttempts(ip) {
  const now = Date.now();
  const times = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, times);
  return times.length >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginAttempt(ip) {
  const times = loginAttempts.get(ip) || [];
  times.push(Date.now());
  loginAttempts.set(ip, times);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// Compare without leaking length or position through timing. Hashing both
// sides first keeps timingSafeEqual's equal-length requirement satisfied.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(value) {
  return crypto
    .createHmac('sha256', config.admin.sessionSecret)
    .update(value)
    .digest('base64url');
}

function issueToken() {
  const payload = JSON.stringify({ exp: Date.now() + config.admin.sessionMaxAgeMs });
  const body = Buffer.from(payload).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [body, signature] = token.split('.');
  if (!body || !signature) return false;
  if (!safeEqual(signature, sign(body))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.admin.sessionMaxAgeMs,
    path: '/',
  };
}

/** Gate for every /api route except login. */
function requireAuth(req, res, next) {
  if (verifyToken(req.cookies?.[COOKIE_NAME])) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

module.exports = {
  COOKIE_NAME,
  LOGIN_MAX_ATTEMPTS,
  cookieOptions,
  issueToken,
  requireAuth,
  safeEqual,
  tooManyLoginAttempts,
  recordLoginAttempt,
  clearLoginAttempts,
  verifyToken,
};
