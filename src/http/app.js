const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { requireAuth } = require('./auth');
const authRoutes = require('./routes/auth');
const statusRoutes = require('./routes/status');
const groupRoutes = require('./routes/groups');
const memberRoutes = require('./routes/members');
const logRoutes = require('./routes/logs');
const settingsRoutes = require('./routes/settings');
const doorRoutes = require('./routes/doors');

const ADMIN_DIST = path.join(__dirname, '..', '..', 'admin', 'dist');

function createApp() {
  const app = express();

  // Railway terminates TLS upstream; without this req.ip is the proxy's and the
  // login throttle would treat every attempt as coming from one client.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);

  // Everything past this point requires a valid panel session.
  app.use('/api', requireAuth);
  app.use('/api/status', statusRoutes);
  app.use('/api/groups', groupRoutes);
  app.use('/api/members', memberRoutes);
  app.use('/api/logs', logRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/doors', doorRoutes);

  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  app.use(express.static(ADMIN_DIST));
  // SPA fallback - client-side routes must resolve to index.html.
  app.get('*', (req, res) => res.sendFile(path.join(ADMIN_DIST, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[http]', err);
    res.status(500).json({ ok: false, error: err.message });
  });

  return app;
}

module.exports = { createApp, ADMIN_DIST };
