const assert = require('assert');
const http = require('http');
const express = require('express');
const { hashPassword } = require('../src/security/passwords');
const { createAiCredentialsRouter } = require('../src/http/routes/ai-credentials');

async function main() {
  const keys = { openai: null, gemini: null };
  const tested = [];
  const passwordHash = await hashPassword('correct-admin-password');
  const AiCredentialsModel = {
    async status() {
      return Object.fromEntries(
        Object.entries(keys).map(([provider, value]) => [
          provider,
          { configured: Boolean(value), source: value ? 'dashboard' : null, updatedAt: null },
        ])
      );
    },
    async setKey(provider, apiKey) {
      keys[provider] = apiKey;
    },
    async clearKey(provider) {
      keys[provider] = null;
    },
  };
  const CredentialsModel = { load: async () => ({ passwordHash }) };
  const getClient = async (provider) => ({
    enabled: Boolean(keys[provider]),
    testConnection: async () => tested.push(provider),
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/ai-credentials',
    createAiCredentialsRouter({ AiCredentialsModel, CredentialsModel, getClient })
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/ai-credentials`;

  async function request(pathname = '', options = {}) {
    const response = await fetch(`${base}${pathname}`, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { response, body: await response.json() };
  }

  try {
    let result = await request();
    assert.strictEqual(result.response.status, 200);
    assert.ok(!JSON.stringify(result.body).includes('apiKey'));

    result = await request('', {
      method: 'POST',
      body: {
        provider: 'openai',
        apiKey: 'sk-secret-key-that-must-not-be-echoed',
        currentPassword: 'wrong',
      },
    });
    assert.strictEqual(result.response.status, 401);
    assert.strictEqual(result.body.error, 'current_password_wrong');

    result = await request('', {
      method: 'POST',
      body: {
        provider: 'openai',
        apiKey: 'sk-secret-key-that-must-not-be-echoed',
        currentPassword: 'correct-admin-password',
      },
    });
    assert.strictEqual(result.response.status, 200);
    assert.strictEqual(result.body.providers.openai.source, 'dashboard');
    assert.ok(!JSON.stringify(result.body).includes('sk-secret-key-that-must-not-be-echoed'));

    result = await request('/openai/test', { method: 'POST' });
    assert.strictEqual(result.response.status, 200);
    assert.deepStrictEqual(tested, ['openai']);

    result = await request('/openai', {
      method: 'DELETE',
      body: { currentPassword: 'correct-admin-password' },
    });
    assert.strictEqual(result.response.status, 200);
    assert.strictEqual(result.body.providers.openai.configured, false);

    result = await request('/gemini/test', { method: 'POST' });
    assert.strictEqual(result.response.status, 400);
    assert.strictEqual(result.body.error, 'provider_not_configured');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('AI credential HTTP tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
