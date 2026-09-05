class LocalDoorActuator {
  constructor({ homeAssistant, entityId, minPulseMs = 100, maxPulseMs = 2000 }) {
    if (!homeAssistant || !entityId) {
      throw new Error('Home Assistant client and front-door entity are required');
    }
    this.homeAssistant = homeAssistant;
    this.entityId = entityId;
    this.minPulseMs = minPulseMs;
    this.maxPulseMs = maxPulseMs;
  }

  async status() {
    try {
      const result = await this.homeAssistant.getState(this.entityId);
      const state = String(result?.state || '').toLowerCase();
      return {
        online: state === 'on' || state === 'off',
        state: state === 'on' || state === 'off' ? state : null,
      };
    } catch {
      return { online: false, state: null };
    }
  }

  async ensureOff() {
    await this.homeAssistant.setState(this.entityId, false);
  }

  async pulse({ door, pulseMs }) {
    if (door !== 'front') throw new Error(`Unsupported local door: ${door}`);
    if (!Number.isInteger(pulseMs) || pulseMs < this.minPulseMs || pulseMs > this.maxPulseMs) {
      throw new Error(
        `Relay pulse must be between ${this.minPulseMs} and ${this.maxPulseMs} ms`
      );
    }

    let attemptedOn = false;
    let turnedOnAt = 0;
    let failure = null;

    try {
      attemptedOn = true;
      turnedOnAt = Date.now();
      await this.homeAssistant.setState(this.entityId, true);
      console.log(`[door-agent] front relay ON for ${pulseMs}ms`);
      const remaining = pulseMs - (Date.now() - turnedOnAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    } catch (err) {
      failure = err;
    } finally {
      if (attemptedOn) {
        if (turnedOnAt) {
          const remaining = pulseMs - (Date.now() - turnedOnAt);
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        }
        try {
          await this.homeAssistant.setState(this.entityId, false);
          console.log('[door-agent] front relay OFF');
        } catch (offError) {
          if (failure) failure.offError = offError;
          else failure = offError;
        }
      }
    }

    if (failure) {
      failure.doorOffline = true;
      throw failure;
    }
    return { simulated: false, unconfirmed: false, reason: null };
  }
}

module.exports = { LocalDoorActuator };
