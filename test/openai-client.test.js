const assert = require('assert');
const { OpenAIClient, extractOutputText } = require('../src/ai/openai-client');

async function main() {
  assert.strictEqual(
    extractOutputText({ output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }] }),
    '{"ok":true}'
  );

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({
      url,
      options,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_text: '{"choice":"yes"}' }),
    };
  };
  const client = new OpenAIClient({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.test/v1/',
    timeoutMs: 500,
    fetchImpl,
  });

  const result = await client.structured({
    instructions: 'Be exact.',
    input: 'hello',
    name: 'test_schema',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { choice: { type: 'string', enum: ['yes', 'no'] } },
      required: ['choice'],
    },
  });
  assert.deepStrictEqual(result, { choice: 'yes' });
  assert.strictEqual(calls[0].url, 'https://example.test/v1/responses');
  assert.strictEqual(calls[0].body.store, false);
  assert.strictEqual(calls[0].body.model, 'test-model');
  assert.strictEqual(calls[0].body.text.format.type, 'json_schema');
  assert.strictEqual(calls[0].body.text.format.strict, true);
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer test-key');

  await client.testConnection();
  assert.strictEqual(calls[1].url, 'https://example.test/v1/models');
  assert.strictEqual(calls[1].options.method, 'GET');
  assert.strictEqual(calls[1].options.body, undefined);

  const moderationClient = new OpenAIClient({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.strictEqual(body.model, 'omni-moderation-latest');
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ flagged: false, categories: {} }] }),
      };
    },
  });
  assert.deepStrictEqual(await moderationClient.moderate('safe'), {
    flagged: false,
    categories: {},
  });

  console.log('OpenAI client tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
