const express = require('express');
const Credentials = require('../../db/models/Credentials');
const {
  COOKIE_NAME,
  cookieOptions,
  issueToken,
  requireAuth,
  hashPassword,
  verifyPassword,
  tooManyLoginAttempts,
  recordLoginAttempt,
  clearLoginAttempts,
  verifyToken,
} = require('../auth');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;

router.post('/login', async (req, res) => {
  const ip = req.ip;

  if (tooManyLoginAttempts(ip)) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }

  const { password } = req.body || {};
  const creds = await Credentials.load();
  if (!password || !(await verifyPassword(password, creds.passwordHash))) {
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

// This route sits under /api/auth, which is mounted BEFORE the app-wide
// requireAuth in http/app.js (login has to be reachable while logged out) -
// so it needs its own requireAuth here. Changing the password also needs the
// CURRENT password, not just a valid session cookie: a stolen cookie (XSS, a
// shared machine) must not be enough to lock the real admin out.
router.post('/password', requireAuth, async (req, res) => {
  const ip = req.ip;
  if (tooManyLoginAttempts(ip)) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }

  const { currentPassword, newPassword } = req.body || {};
  const creds = await Credentials.load();
  if (!currentPassword || !(await verifyPassword(currentPassword, creds.passwordHash))) {
    recordLoginAttempt(ip);
    return res.status(401).json({ ok: false, error: 'current password is wrong' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      ok: false,
      error: `new password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  clearLoginAttempts(ip);
  creds.passwordHash = await hashPassword(newPassword);
  await creds.save();
  // The existing session cookie is unrelated to the password - no need to
  // force a re-login.
  return res.json({ ok: true });
});

module.exports = router;
