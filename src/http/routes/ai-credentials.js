const express = require('express');
const AiCredentials = require('../../db/models/AiCredentials');
const Credentials = require('../../db/models/Credentials');
const { getConfiguredAIClient } = require('../../ai/provider');
const {
  verifyPassword,
  tooManyLoginAttempts,
  recordLoginAttempt,
  clearLoginAttempts,
} = require('../auth');

const PROVIDERS = new Set(['openai', 'gemini']);
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 512;

function createAiCredentialsRouter({
  AiCredentialsModel = AiCredentials,
  CredentialsModel = Credentials,
  getClient = getConfiguredAIClient,
} = {}) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      return res.json({ ok: true, providers: await AiCredentialsModel.status() });
    } catch (err) {
      console.error('[ai-credentials] could not read status:', err.message);
      return res.status(500).json({ ok: false, error: 'credential_status_failed' });
    }
  });

  router.post('/', async (req, res) => {
    const provider = String(req.body?.provider || '').toLowerCase();
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!PROVIDERS.has(provider)) {
      return res.status(400).json({ ok: false, error: 'unknown_provider' });
    }
    if (
      apiKey.length < MIN_KEY_LENGTH ||
      apiKey.length > MAX_KEY_LENGTH ||
      /\s/.test(apiKey)
    ) {
      return res.status(400).json({ ok: false, error: 'invalid_api_key' });
    }
    try {
      if (!(await verifyCurrentPassword(req, res, CredentialsModel))) return;
      await AiCredentialsModel.setKey(provider, apiKey);
      return res.json({ ok: true, providers: await AiCredentialsModel.status() });
    } catch (err) {
      console.error(`[ai-credentials] could not store ${provider} key:`, err.message);
      return res.status(500).json({ ok: false, error: 'credential_save_failed' });
    }
  });

  router.delete('/:provider', async (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!PROVIDERS.has(provider)) {
      return res.status(400).json({ ok: false, error: 'unknown_provider' });
    }
    try {
      if (!(await verifyCurrentPassword(req, res, CredentialsModel))) return;
      await AiCredentialsModel.clearKey(provider);
      return res.json({ ok: true, providers: await AiCredentialsModel.status() });
    } catch (err) {
      console.error(`[ai-credentials] could not remove ${provider} key:`, err.message);
      return res.status(500).json({ ok: false, error: 'credential_remove_failed' });
    }
  });

  router.post('/:provider/test', async (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!PROVIDERS.has(provider)) {
      return res.status(400).json({ ok: false, error: 'unknown_provider' });
    }
    try {
      const client = await getClient(provider);
      if (!client?.enabled) {
        return res.status(400).json({ ok: false, error: 'provider_not_configured' });
      }
      await client.testConnection();
      return res.json({ ok: true });
    } catch (err) {
      const status = String(err?.message || '').match(/\((\d{3})\)/)?.[1] || 'request_failed';
      console.warn(`[ai-credentials] ${provider} connection test failed: ${status}`);
      return res.status(502).json({ ok: false, error: 'provider_connection_failed' });
    }
  });

  return router;
}

async function verifyCurrentPassword(req, res, CredentialsModel) {
  const ip = req.ip;
  if (tooManyLoginAttempts(ip)) {
    res.status(429).json({ ok: false, error: 'too_many_attempts' });
    return false;
  }

  const credentials = await CredentialsModel.load();
  if (!(await verifyPassword(req.body?.currentPassword, credentials.passwordHash))) {
    recordLoginAttempt(ip);
    res.status(401).json({ ok: false, error: 'current_password_wrong' });
    return false;
  }
  clearLoginAttempts(ip);
  return true;
}

const router = createAiCredentialsRouter();

module.exports = router;
module.exports.createAiCredentialsRouter = createAiCredentialsRouter;
