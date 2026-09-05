/**
 * Small Responses API client built on Node's fetch.
 *
 * There is intentionally no retry: a slow stylistic reply is worse than the
 * deterministic fallback, and a late intent classification must never open a
 * door after the sender has stopped expecting it.
 */
class OpenAIClient {
  constructor({ apiKey, model, baseUrl, timeoutMs, fetchImpl = global.fetch } = {}) {
    this.apiKey = apiKey || null;
    this.model = model || 'gpt-4o-mini';
    this.baseUrl = String(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.timeoutMs = Math.max(250, Number(timeoutMs) || 1500);
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.apiKey && this.fetch);
  }

  async request(path, { method = 'POST', body } = {}) {
    if (!this.enabled) throw new Error('OpenAI is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Do not echo response bodies: they can repeat submitted message text.
        throw new Error(`OpenAI request failed (${response.status})`);
      }
      return response.json();
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('OpenAI request timed out');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  post(path, body) {
    return this.request(path, { method: 'POST', body });
  }

  async testConnection() {
    await this.request('/models', { method: 'GET' });
    return true;
  }

  async structured({ instructions, input, name, schema, maxOutputTokens = 160 }) {
    const response = await this.post('/responses', {
      model: this.model,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name,
          strict: true,
          schema,
        },
      },
    });

    const text = extractOutputText(response);
    if (!text) throw new Error('OpenAI returned no structured output');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('OpenAI returned invalid structured output');
    }
  }

  async moderate(input) {
    const response = await this.post('/moderations', {
      model: 'omni-moderation-latest',
      input,
    });
    const result = response?.results?.[0];
    if (!result || typeof result.flagged !== 'boolean') {
      throw new Error('OpenAI returned no moderation result');
    }
    return { flagged: result.flagged, categories: result.categories || {} };
  }
}

function extractOutputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  return null;
}

module.exports = { OpenAIClient, extractOutputText };
