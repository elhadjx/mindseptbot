const crypto = require('crypto');

function bridgeError(message, code = 'bridge_unavailable', { doorOffline = true } = {}) {
  const err = new Error(message);
  err.bridgeCode = code;
  err.connectionError = doorOffline;
  err.doorOffline = doorOffline;
  return err;
}

function safeTokenEqual(expected, authorization) {
  if (!expected || typeof authorization !== 'string') return false;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  // Hash both sides first so timingSafeEqual always receives equal-size buffers.
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  const receivedHash = crypto.createHash('sha256').update(match[1]).digest();
  return crypto.timingSafeEqual(expectedHash, receivedHash);
}

class DoorBridgeCoordinator {
  constructor({
    token,
    expectedAgentId = 'building-pc',
    heartbeatTtlMs = 45000,
    claimTimeoutMs = 5000,
    resultTimeoutMs = 30000,
    pollWaitMs = 20000,
    now = () => Date.now(),
  } = {}) {
    this.token = token;
    this.expectedAgentId = expectedAgentId;
    this.heartbeatTtlMs = heartbeatTtlMs;
    this.claimTimeoutMs = claimTimeoutMs;
    this.resultTimeoutMs = resultTimeoutMs;
    this.pollWaitMs = pollWaitMs;
    this.now = now;
    this.queue = [];
    this.waiters = [];
    this.jobs = new Map();
    this.heartbeat = null;
  }

  get enabled() {
    return Boolean(this.token);
  }

  authenticate(authorization) {
    return safeTokenEqual(this.token, authorization);
  }

  _assertAgent(agentId) {
    if (!agentId || agentId !== this.expectedAgentId) {
      const err = new Error('Unknown door agent');
      err.bridgeCode = 'unknown_agent';
      throw err;
    }
  }

  noteHeartbeat(agentId, status = {}) {
    this._assertAgent(agentId);
    const front = status?.doors?.front || {};
    this.heartbeat = {
      agentId,
      at: this.now(),
      doors: {
        front: {
          online: front.online === true,
          state: front.state === 'on' || front.state === 'off' ? front.state : null,
        },
      },
    };
  }

  isAgentOnline() {
    return Boolean(
      this.heartbeat && this.now() - this.heartbeat.at <= this.heartbeatTtlMs
    );
  }

  getDoorState(door) {
    if (door !== 'front' || !this.isAgentOnline()) {
      return { online: false, dp: undefined };
    }
    const state = this.heartbeat.doors.front;
    return {
      online: state.online,
      dp: state.state === 'on' ? true : state.state === 'off' ? false : undefined,
    };
  }

  _publicJob(job) {
    return {
      id: job.id,
      type: job.type,
      door: job.door,
      pulseMs: job.pulseMs,
      createdAt: new Date(job.createdAt).toISOString(),
      expiresAt: new Date(job.expiresAt).toISOString(),
    };
  }

  _claim(job, agentId) {
    if (!job || job.state !== 'queued') return null;
    job.state = 'claimed';
    job.claimedBy = agentId;
    clearTimeout(job.claimTimer);
    job.resultTimer = setTimeout(() => {
      this._failJob(
        job,
        bridgeError('Local door agent did not report a result', 'bridge_result_timeout')
      );
    }, this.resultTimeoutMs);
    return this._publicJob(job);
  }

  _takeQueued(agentId) {
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (job.state !== 'queued') continue;
      if (job.expiresAt <= this.now()) {
        this._failJob(job, bridgeError('Door command expired before claim', 'bridge_claim_timeout'));
        continue;
      }
      return this._claim(job, agentId);
    }
    return null;
  }

  async poll({ agentId, status, signal }) {
    this.noteHeartbeat(agentId, status);
    if (signal?.aborted) return null;
    const queued = this._takeQueued(agentId);
    if (queued) return queued;

    return new Promise((resolve) => {
      let settled = false;
      const waiter = { agentId, resolve: null, timer: null, onAbort: null };
      const finish = (job) => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        if (signal && waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort);
        resolve(job);
      };
      waiter.resolve = finish;
      waiter.onAbort = () => finish(null);
      waiter.timer = setTimeout(() => {
        finish(null);
      }, this.pollWaitMs);
      this.waiters.push(waiter);
      if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  _dispatch(job) {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.queue.push(job);
      return;
    }
    waiter.resolve(this._claim(job, waiter.agentId));
  }

  enqueuePulse({ door, pulseMs }) {
    if (!this.isAgentOnline()) {
      return Promise.reject(bridgeError('Local door agent is offline', 'bridge_agent_offline'));
    }
    if (door !== 'front') {
      return Promise.reject(
        bridgeError(`Unsupported bridge door: ${door}`, 'unsupported_door', {
          doorOffline: false,
        })
      );
    }
    if (!Number.isInteger(pulseMs) || pulseMs < 100 || pulseMs > 2000) {
      return Promise.reject(
        bridgeError('Relay pulse must be between 100 and 2000 ms', 'invalid_pulse', {
          doorOffline: false,
        })
      );
    }

    const createdAt = this.now();
    const job = {
      id: crypto.randomUUID(),
      type: 'pulse',
      door,
      pulseMs,
      createdAt,
      expiresAt: createdAt + this.claimTimeoutMs,
      state: 'queued',
      claimedBy: null,
      claimTimer: null,
      resultTimer: null,
      resolve: null,
      reject: null,
    };

    const result = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.jobs.set(job.id, job);
    job.claimTimer = setTimeout(() => {
      this._failJob(
        job,
        bridgeError('Local door agent did not claim the command', 'bridge_claim_timeout')
      );
    }, this.claimTimeoutMs);
    this._dispatch(job);
    return result;
  }

  complete({ agentId, jobId, result }) {
    this._assertAgent(agentId);
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'claimed' || job.claimedBy !== agentId) return false;

    clearTimeout(job.resultTimer);
    this.jobs.delete(job.id);
    job.state = 'completed';

    if (result?.ok === true) {
      job.resolve({
        simulated: false,
        unconfirmed: Boolean(result.unconfirmed),
        reason: result.reason || null,
      });
      return true;
    }

    const message = String(result?.error?.message || 'Local door command failed').slice(0, 300);
    const err = bridgeError(message, result?.error?.code || 'bridge_command_failed', {
      doorOffline: result?.error?.doorOffline !== false,
    });
    job.reject(err);
    return true;
  }

  _failJob(job, err) {
    if (!job || !this.jobs.has(job.id)) return;
    clearTimeout(job.claimTimer);
    clearTimeout(job.resultTimer);
    this.queue = this.queue.filter((candidate) => candidate !== job);
    this.jobs.delete(job.id);
    job.state = 'failed';
    job.reject(err);
  }

  close() {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters = [];
    for (const job of this.jobs.values()) {
      this._failJob(job, bridgeError('Door bridge stopped', 'bridge_stopped'));
    }
  }
}

module.exports = { DoorBridgeCoordinator, bridgeError, safeTokenEqual };
