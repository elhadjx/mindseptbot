/** Minimal Gemini Interactions API client, matching the interface DoorAI uses. */
class GeminiClient {
  constructor({ apiKey, model, baseUrl, timeoutMs, fetchImpl = global.fetch } = {}) {
    this.apiKey = apiKey || null;
    this.model = model || 'gemini-3.1-flash-lite';
    this.baseUrl = String(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      ''
    );
    this.timeoutMs = Math.max(250, Number(timeoutMs) || 1500);
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.apiKey && this.fetch);
  }

  async request(path, { method = 'POST', body } = {}) {
    if (!this.enabled) throw new Error('Gemini is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-goog-api-key': this.apiKey,
          'Api-Revision': '2026-05-20',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Provider error bodies can repeat submitted text. Status is enough for
        // the dashboard and logs, and cannot leak the credential.
        throw new Error(`Gemini request failed (${response.status})`);
      }
      return response.json();
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('Gemini request timed out');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async structured({ instructions, input, schema, maxOutputTokens = 160 }) {
    const response = await this.request('/interactions', {
      body: {
        model: this.model,
        system_instruction: instructions,
        input,
        store: false,
        generation_config: {
          max_output_tokens: maxOutputTokens,
          thinking_level: 'minimal',
          tool_choice: 'none',
        },
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema,
        },
      },
    });

    const text = extractGeminiOutputText(response);
    if (!text) throw new Error('Gemini returned no structured output');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Gemini returned invalid structured output');
    }
  }

  async moderate(input) {
    const result = await this.structured({
      instructions:
        'Act only as a strict workplace-safety classifier. Mark safe=false for harassment, insults, shaming, sexual or romantic content, protected-trait references, health, politics, money, violence, drugs, or profanity. Return JSON only.',
      input: String(input || '').slice(0, 300),
      maxOutputTokens: 40,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { safe: { type: 'boolean' } },
        required: ['safe'],
      },
    });
    return { flagged: result?.safe !== true, categories: {} };
  }

  async testConnection() {
    await this.request('/models?pageSize=1', { method: 'GET' });
    return true;
  }
}

function extractGeminiOutputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  for (const step of response?.steps || []) {
    if (step?.type !== 'model_output') continue;
    for (const content of step.content || []) {
      if (content?.type === 'text' && typeof content.text === 'string') return content.text;
    }
  }
  // Tolerate the pre-May-2026 shape if a compatible proxy still returns it.
  for (const output of response?.outputs || []) {
    if (output?.type === 'text' && typeof output.text === 'string') return output.text;
  }
  return null;
}

module.exports = { GeminiClient, extractGeminiOutputText };
