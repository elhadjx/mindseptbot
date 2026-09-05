const { HomeAssistantClient } = require('../doors/home-assistant');
const { LocalDoorActuator } = require('./local-door');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadAgentConfig() {
  const serverUrl = required('BRIDGE_SERVER_URL').replace(/\/$/, '');
  const parsed = new URL(serverUrl);
  const localHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHost)) {
    throw new Error('BRIDGE_SERVER_URL must use HTTPS (HTTP is allowed only for localhost)');
  }

  return {
    serverUrl,
    token: required('DOOR_BRIDGE_TOKEN'),
    agentId: process.env.DOOR_BRIDGE_AGENT_ID || 'building-pc',
    requestTimeoutMs: Number(process.env.BRIDGE_REQUEST_TIMEOUT_MS) || 30000,
    retryMaxMs: Number(process.env.BRIDGE_RETRY_MAX_MS) || 15000,
    homeAssistant: {
      baseUrl: required('HOME_ASSISTANT_URL'),
      accessToken: required('HOME_ASSISTANT_TOKEN'),
      timeoutMs: Number(process.env.HOME_ASSISTANT_TIMEOUT_MS) || 5000,
    },
    entityId: required('HOME_ASSISTANT_FRONT_ENTITY_ID'),
    maxPulseMs: Math.min(2000, Number(process.env.MAX_RELAY_PULSE_MS) || 2000),
  };
}

class BridgeApiClient {
  constructor({ serverUrl, token, requestTimeoutMs = 30000 }) {
    this.serverUrl = serverUrl;
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
    this.controllers = new Set();
  }

  async request(path, body) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await fetch(this.serverUrl + path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      const message =
        cause?.name === 'AbortError'
          ? 'Railway bridge request timed out'
          : `Railway bridge request failed: ${cause?.message || cause}`;
      const err = new Error(message);
      err.cause = cause;
      throw err;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // An upstream proxy can return an HTML error page. Status is sufficient.
    }
    if (!response.ok) {
      const err = new Error(`Railway bridge API returned ${response.status}`);
      err.status = response.status;
      err.code = payload?.error;
      throw err;
    }
    return payload;
  }

  poll(agentId, status) {
    return this.request('/internal/door-bridge/poll', { agentId, status });
  }

  complete(agentId, jobId, result) {
    return this.request(`/internal/door-bridge/jobs/${encodeURIComponent(jobId)}/result`, {
      agentId,
      result,
    });
  }

  abortPending() {
    for (const controller of this.controllers) controller.abort();
  }
}

function serialiseFailure(err) {
  return {
    ok: false,
    error: {
      code: 'local_actuation_failed',
      message: String(err?.message || err).slice(0, 300),
      doorOffline: err?.doorOffline !== false,
    },
  };
}

class DoorAgent {
  constructor({ api, actuator, agentId, retryMaxMs = 15000 }) {
    this.api = api;
    this.actuator = actuator;
    this.agentId = agentId;
    this.retryMaxMs = retryMaxMs;
    this.running = false;
    this.processed = new Map();
  }

  async _resultFor(job) {
    if (!job?.id || job.type !== 'pulse') {
      return serialiseFailure(new Error('Invalid door job'));
    }
    if (this.processed.has(job.id)) return this.processed.get(job.id);

    let result;
    if (!job.expiresAt || Date.parse(job.expiresAt) <= Date.now()) {
      const err = new Error('Door job expired before execution');
      err.doorOffline = false;
      result = serialiseFailure(err);
    } else {
      try {
        const opened = await this.actuator.pulse({ door: job.door, pulseMs: job.pulseMs });
        result = { ok: true, ...opened };
      } catch (err) {
        result = serialiseFailure(err);
      }
    }

    this.processed.set(job.id, result);
    if (this.processed.size > 100) {
      this.processed.delete(this.processed.keys().next().value);
    }
    return result;
  }

  async _report(job, result) {
    let delayMs = 500;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.api.complete(this.agentId, job.id, result);
        return;
      } catch (err) {
        if (err.status === 410) return;
        if (attempt === 3) throw err;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
    }
  }

  async run() {
    this.running = true;
    try {
      await this.actuator.ensureOff();
      console.log('[door-agent] startup safety: relay OFF');
    } catch (err) {
      console.warn('[door-agent] startup safety OFF failed:', err.message);
    }

    let retryMs = 1000;
    while (this.running) {
      try {
        const front = await this.actuator.status();
        const response = await this.api.poll(this.agentId, { doors: { front } });
        retryMs = 1000;
        if (!response?.job) continue;

        const result = await this._resultFor(response.job);
        await this._report(response.job, result);
      } catch (err) {
        if (!this.running) break;
        console.error('[door-agent]', err.message);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, this.retryMaxMs);
      }
    }
  }

  stop() {
    this.running = false;
    this.api.abortPending?.();
  }
}

async function main() {
  const config = loadAgentConfig();
  const homeAssistant = new HomeAssistantClient(config.homeAssistant);
  const actuator = new LocalDoorActuator({
    homeAssistant,
    entityId: config.entityId,
    maxPulseMs: config.maxPulseMs,
  });
  const api = new BridgeApiClient(config);
  const agent = new DoorAgent({
    api,
    actuator,
    agentId: config.agentId,
    retryMaxMs: config.retryMaxMs,
  });

  process.on('SIGINT', () => agent.stop());
  process.on('SIGTERM', () => agent.stop());
  console.log(`[door-agent] starting as ${config.agentId}`);
  await agent.run();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[door-agent] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  BridgeApiClient,
  DoorAgent,
  loadAgentConfig,
  serialiseFailure,
};
