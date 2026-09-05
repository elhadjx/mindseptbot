const { mongoose } = require('../mongo');
const { config } = require('../../config');
const { encryptSecret, decryptSecret } = require('../../security/secrets');

const PROVIDERS = Object.freeze(['openai', 'gemini']);
const FIELDS = Object.freeze({
  openai: { encrypted: 'openaiKeyEncrypted', updatedAt: 'openaiKeyUpdatedAt' },
  gemini: { encrypted: 'geminiKeyEncrypted', updatedAt: 'geminiKeyUpdatedAt' },
});

const aiCredentialsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    openaiKeyEncrypted: { type: String, default: null, select: false },
    geminiKeyEncrypted: { type: String, default: null, select: false },
    openaiKeyUpdatedAt: { type: Date, default: null },
    geminiKeyUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, _id: false }
);

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error('unknown AI provider');
}

function environmentKey(provider) {
  return provider === 'openai' ? config.ai.apiKey : config.ai.geminiApiKey;
}

aiCredentialsSchema.statics.load = async function load({ includeSecrets = false } = {}) {
  // Upsert avoids a duplicate-key race when the dashboard and a WhatsApp
  // message are the first two callers after a fresh deployment.
  let query = this.findOneAndUpdate(
    { _id: 'global' },
    { $setOnInsert: { _id: 'global' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  if (includeSecrets) query = query.select('+openaiKeyEncrypted +geminiKeyEncrypted');
  return query;
};

aiCredentialsSchema.statics.resolveKey = async function resolveKey(provider) {
  assertProvider(provider);
  const field = FIELDS[provider].encrypted;
  const doc = await this.load({ includeSecrets: true });
  if (doc[field]) {
    try {
      return decryptSecret(doc[field], config.admin.sessionSecret);
    } catch (err) {
      console.error(`[ai-credentials] ${provider} dashboard key cannot be decrypted`);
      return null;
    }
  }
  return environmentKey(provider) || null;
};

aiCredentialsSchema.statics.status = async function status() {
  const doc = await this.load({ includeSecrets: true });
  const out = {};
  for (const provider of PROVIDERS) {
    const { encrypted, updatedAt } = FIELDS[provider];
    let source = null;
    if (doc[encrypted]) {
      try {
        decryptSecret(doc[encrypted], config.admin.sessionSecret);
        source = 'dashboard';
      } catch {
        source = 'unreadable';
      }
    } else if (environmentKey(provider)) {
      source = 'environment';
    }
    out[provider] = {
      configured: source === 'dashboard' || source === 'environment',
      source,
      updatedAt: doc[updatedAt] || null,
    };
  }
  return out;
};

aiCredentialsSchema.statics.setKey = async function setKey(provider, apiKey) {
  assertProvider(provider);
  const { encrypted, updatedAt } = FIELDS[provider];
  const doc = await this.load({ includeSecrets: true });
  doc[encrypted] = encryptSecret(apiKey, config.admin.sessionSecret);
  doc[updatedAt] = new Date();
  await doc.save();
};

aiCredentialsSchema.statics.clearKey = async function clearKey(provider) {
  assertProvider(provider);
  const { encrypted, updatedAt } = FIELDS[provider];
  const doc = await this.load({ includeSecrets: true });
  doc[encrypted] = null;
  doc[updatedAt] = null;
  await doc.save();
};

module.exports = mongoose.model('AiCredentials', aiCredentialsSchema);
module.exports.PROVIDERS = PROVIDERS;
