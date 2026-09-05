const path = require('path');
const assert = require('assert');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { config } = require('../src/config');
const { connectMongo, mongoose } = require('../src/db/mongo');
const AiCredentials = require('../src/db/models/AiCredentials');

async function main() {
  await connectMongo();
  await AiCredentials.deleteMany({});

  const originalSessionSecret = config.admin.sessionSecret;
  const originalOpenAIKey = config.ai.apiKey;
  const originalGeminiKey = config.ai.geminiApiKey;
  config.ai.apiKey = null;
  config.ai.geminiApiKey = null;

  try {
    const initial = await AiCredentials.status();
    assert.deepStrictEqual(initial.openai, { configured: false, source: null, updatedAt: null });

    const apiKey = 'sk-dashboard-plaintext-must-never-be-stored';
    await AiCredentials.setKey('openai', apiKey);
    const raw = await mongoose.connection.db
      .collection(AiCredentials.collection.name)
      .findOne({ _id: 'global' });
    assert.ok(raw.openaiKeyEncrypted.startsWith('v1.'));
    assert.ok(!JSON.stringify(raw).includes(apiKey));
    assert.strictEqual(await AiCredentials.resolveKey('openai'), apiKey);

    const safeStatus = await AiCredentials.status();
    assert.strictEqual(safeStatus.openai.configured, true);
    assert.strictEqual(safeStatus.openai.source, 'dashboard');
    assert.ok(safeStatus.openai.updatedAt instanceof Date);
    assert.ok(!JSON.stringify(safeStatus).includes(apiKey));

    config.ai.apiKey = 'sk-environment-fallback';
    await AiCredentials.clearKey('openai');
    assert.strictEqual(await AiCredentials.resolveKey('openai'), 'sk-environment-fallback');
    assert.strictEqual((await AiCredentials.status()).openai.source, 'environment');

    await AiCredentials.setKey('openai', apiKey);
    config.admin.sessionSecret = 'rotated-without-reentering-the-dashboard-key';
    assert.strictEqual(await AiCredentials.resolveKey('openai'), null);
    const unreadable = await AiCredentials.status();
    assert.strictEqual(unreadable.openai.configured, false);
    assert.strictEqual(unreadable.openai.source, 'unreadable');
  } finally {
    config.admin.sessionSecret = originalSessionSecret;
    config.ai.apiKey = originalOpenAIKey;
    config.ai.geminiApiKey = originalGeminiKey;
    await AiCredentials.deleteMany({});
    await mongoose.disconnect();
  }

  console.log('AI credential storage tests passed');
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
