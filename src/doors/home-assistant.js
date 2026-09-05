class HomeAssistantClient {
  constructor({ baseUrl, accessToken, timeoutMs = 5000 }) {
    if (!baseUrl || !accessToken) {
      throw new Error('Home Assistant baseUrl/accessToken are required');
    }

    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid Home Assistant URL: ${baseUrl}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Home Assistant URL must use http or https');
    }

    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.accessToken = accessToken;
    this.timeoutMs = timeoutMs;
  }

  async _request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;

    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      const err = new Error(
        cause?.name === 'AbortError'
          ? `Home Assistant request timed out after ${this.timeoutMs}ms`
          : `Home Assistant request failed: ${cause?.message || cause}`
      );
      err.connectionError = true;
      err.cause = cause;
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const detail =
        typeof payload === 'string'
          ? payload.slice(0, 200)
          : payload?.message || payload?.error || response.statusText;
      const err = new Error(
        `Home Assistant API error ${response.status}${detail ? `: ${detail}` : ''}`
      );
      err.homeAssistantStatus = response.status;
      throw err;
    }

    return payload;
  }

  async getState(entityId) {
    return this._request('GET', `/api/states/${encodeURIComponent(entityId)}`);
  }

  async setState(entityId, enabled) {
    const domain = String(entityId).split('.')[0];
    if (!domain || !String(entityId).includes('.')) {
      throw new Error(`Invalid Home Assistant entity id: ${entityId}`);
    }
    const service = enabled ? 'turn_on' : 'turn_off';
    return this._request('POST', `/api/services/${domain}/${service}`, {
      entity_id: entityId,
    });
  }
}

module.exports = { HomeAssistantClient };
