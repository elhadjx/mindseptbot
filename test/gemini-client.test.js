const assert = require('assert');
const { GeminiClient, extractGeminiOutputText } = require('../src/ai/gemini-client');

async function main() {
  assert.strictEqual(
    extractGeminiOutputText({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }],
    }),
    '{"ok":true}'
  );
  assert.strictEqual(
    extractGeminiOutputText({ outputs: [{ type: 'text', text: '{"legacy":true}' }] }),
    '{"legacy":true}'
  );

  const calls = [];
  const client = new GeminiClient({
    apiKey: 'gemini-test-key',
    model: 'gemini-test-model',
    baseUrl: 'https://example.test/v1beta/',
    timeoutMs: 500,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          steps: [
            { type: 'model_output', content: [{ type: 'text', text: '{"choice":"yes"}' }] },
          ],
        }),
      };
    },
  });

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { choice: { type: 'string', enum: ['yes', 'no'] } },
    required: ['choice'],
  };
  assert.deepStrictEqual(
    await client.structured({ instructions: 'Be exact.', input: 'hello', schema }),
    { choice: 'yes' }
  );
  assert.strictEqual(calls[0].url, 'https://example.test/v1beta/interactions');
  assert.strictEqual(calls[0].options.headers['x-goog-api-key'], 'gemini-test-key');
  assert.strictEqual(calls[0].options.headers['Api-Revision'], '2026-05-20');
  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.model, 'gemini-test-model');
  assert.strictEqual(body.store, false);
  assert.strictEqual(body.generation_config.tool_choice, 'none');
  assert.strictEqual(body.response_format.mime_type, 'application/json');
  assert.deepStrictEqual(body.response_format.schema, schema);

  await client.testConnection();
  assert.strictEqual(calls[1].url, 'https://example.test/v1beta/models?pageSize=1');
  assert.strictEqual(calls[1].options.method, 'GET');
  assert.strictEqual(calls[1].options.body, undefined);

  const failing = new GeminiClient({
    apiKey: 'do-not-leak-this-key',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(
    () => failing.testConnection(),
    (err) => /\(401\)/.test(err.message) && !err.message.includes('do-not-leak-this-key')
  );

  console.log('Gemini client tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
