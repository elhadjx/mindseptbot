const { config } = require('../config');
const AiCredentials = require('../db/models/AiCredentials');
const { OpenAIClient } = require('./openai-client');
const { GeminiClient } = require('./gemini-client');

function createAIClient(provider, apiKey, { fetchImpl, timeoutMs = config.ai.timeoutMs } = {}) {
  if (provider === 'openai') {
    return new OpenAIClient({
      apiKey,
      model: config.ai.model,
      baseUrl: config.ai.baseUrl,
      timeoutMs,
      fetchImpl,
    });
  }
  if (provider === 'gemini') {
    return new GeminiClient({
      apiKey,
      model: config.ai.geminiModel,
      baseUrl: config.ai.geminiBaseUrl,
      timeoutMs,
      fetchImpl,
    });
  }
  return null;
}

async function getConfiguredAIClient(provider, options) {
  const apiKey = await AiCredentials.resolveKey(provider);
  return apiKey ? createAIClient(provider, apiKey, options) : null;
}

module.exports = { createAIClient, getConfiguredAIClient };
