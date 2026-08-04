const express = require('express');
const { config } = require('../../config');
const {
  COOKIE_NAME,
  cookieOptions,
  issueToken,
  safeEqual,
  tooManyLoginAttempts,
  recordLoginAttempt,
  clearLoginAttempts,
  verifyToken,
} = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const ip = req.ip;

  if (tooManyLoginAttempts(ip)) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }

  const { password } = req.body || {};
  if (!password || !safeEqual(password, config.admin.password)) {
    recordLoginAttempt(ip);
    return res.status(401).json({ ok: false, error: 'invalid_password' });
  }

  clearLoginAttempts(ip);
  res.cookie(COOKIE_NAME, issueToken(), cookieOptions());
  return res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  return res.json({ ok: true });
});

// Lets the SPA decide between the login screen and the app on first paint.
router.get('/session', (req, res) => {
  res.json({ ok: true, authenticated: verifyToken(req.cookies?.[COOKIE_NAME]) });
});

module.exports = router;
