const { config } = require('../config');
const { TuyaCloudClient } = require('./tuya-cloud');
const { HomeAssistantClient } = require('./home-assistant');

const PROVIDERS = new Set(['tuya', 'home_assistant', 'bridge']);
if (!PROVIDERS.has(config.doors.provider)) {
  throw new Error(`Unknown door provider: ${config.doors.provider}`);
}

const tuya = config.doors.provider === 'tuya' ? new TuyaCloudClient(config.tuya) : null;
const homeAssistant =
  config.doors.provider === 'home_assistant'
    ? new HomeAssistantClient(config.homeAssistant)
    : null;
const bridge =
  config.doors.provider === 'bridge'
    ? require('../bridge/runtime').bridgeCoordinator
    : null;

// The inner door is a smart lock (Tuya category "jtmspro"), not a plain relay
// switch. Only the front-door relay is in scope for this provider migration.
const DOORS = {
  front: {
    label: 'Front door',
    deviceId: config.doors.frontDeviceId,
    dpCode: 'switch_1',
    homeAssistantEntityId: config.doors.frontHomeAssistantEntityId,
  },
};

function isConfigured(door) {
  if (bridge) return bridge.enabled;
  return config.doors.provider === 'home_assistant'
    ? Boolean(door.homeAssistantEntityId)
    : Boolean(door.deviceId);
}

function listDoors() {
  return Object.entries(DOORS).map(([key, door]) => ({
    key,
    label: door.label,
    configured: isConfigured(door),
  }));
}

/**
 * Everything the active provider can tell us about the relay in one call:
 * whether it is reachable and the switch state it last reported.
 *
 * @returns {Promise<{online: boolean|null, dp: *}|null>} null means the call
 *   failed. `dp` undefined means the response carried no binary switch state.
 */
async function readDoorState(doorKey) {
  const door = DOORS[doorKey];
  if (!door || !isConfigured(door)) return null;

  try {
    if (bridge) return bridge.getDoorState(doorKey);

    if (homeAssistant) {
      const result = await homeAssistant.getState(door.homeAssistantEntityId);
      const state = String(result?.state || '').toLowerCase();
      if (state === 'unavailable' || state === 'unknown') {
        return { online: false, dp: undefined };
      }
      return {
        online: state ? true : null,
        dp: state === 'on' ? true : state === 'off' ? false : undefined,
      };
    }

    const result = await tuya.request('GET', `/v1.0/iot-03/devices/${door.deviceId}`);
    const status = Array.isArray(result?.status) ? result.status : null;
    return {
      online: typeof result?.online === 'boolean' ? result.online : null,
      dp: status ? status.find((point) => point.code === door.dpCode)?.value : undefined,
    };
  } catch (err) {
    console.warn(`[${door.label}] state read failed:`, err.message);
    // A configured entity that Home Assistant cannot find is known to be
    // unavailable, not an ambiguous network hiccup.
    if (homeAssistant && err.homeAssistantStatus === 404) {
      return { online: false, dp: undefined };
    }
    return null;
  }
}

async function checkDoorOnline(doorKey) {
  const state = await readDoorState(doorKey);
  return state ? state.online : null;
}

function judgePulse(state) {
  if (!state || state.dp === undefined) return null;
  if (state.online === false) return 'offline';
  return state.dp === true ? 'switched' : 'no_switch';
}

const OFFLINE_ERROR_CODES = new Set([2007, 2009]);
const OFFLINE_HTTP_STATUSES = new Set([408, 502, 503, 504]);

function isOfflineError(err) {
  if (tuya) return OFFLINE_ERROR_CODES.has(Number(err?.tuyaCode));
  if (bridge) {
    return Boolean(err?.doorOffline || err?.connectionError);
  }
  return Boolean(
    err?.connectionError || OFFLINE_HTTP_STATUSES.has(Number(err?.homeAssistantStatus))
  );
}

async function setDoorState(door, enabled) {
  if (homeAssistant) {
    await homeAssistant.setState(door.homeAssistantEntityId, enabled);
    return;
  }
  await tuya.request('POST', `/v1.0/iot-03/devices/${door.deviceId}/commands`, {
    commands: [{ code: door.dpCode, value: enabled }],
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pulse the front-door relay and verify that it reported ON while held.
 *
 * Returns { simulated, unconfirmed, reason }. `unconfirmed` means nothing here
 * proves the relay moved, so callers must not report it as a plain success.
 */
async function triggerDoor(doorKey, { pulseMs = config.doors.relayPulseMs, simulate = false } = {}) {
  const door = DOORS[doorKey];
  if (!door) {
    throw new Error(`Unknown or unsupported door: ${doorKey}`);
  }
  if (!isConfigured(door)) {
    const variable = {
      home_assistant: 'HOME_ASSISTANT_FRONT_ENTITY_ID',
      bridge: 'DOOR_BRIDGE_TOKEN',
      tuya: 'DOOR_FRONT_DEVICE_ID',
    }[config.doors.provider];
    throw new Error(`${door.label} is not configured (missing ${variable} in .env)`);
  }

  if (simulate) {
    console.log(`[${door.label}] TEST MODE - pretending to pulse the relay, nothing was sent`);
    return { simulated: true, unconfirmed: false, reason: null };
  }

  let wasOffline = false;
  if ((await checkDoorOnline(doorKey)) === false) {
    console.warn(
      `[${door.label}] reported offline, re-checking in ${config.doors.offlineRecheckMs}ms`
    );
    await sleep(config.doors.offlineRecheckMs);
    wasOffline = (await checkDoorOnline(doorKey)) === false;
    if (wasOffline) {
      console.warn(`[${door.label}] still offline - trying the relay anyway`);
    }
  }

  // A bridge job is one atomic local pulse. Never send separate ON and OFF
  // jobs across the internet: a slow or broken connection between them could
  // leave the relay energised.
  if (bridge) {
    try {
      return await bridge.enqueuePulse({ door: doorKey, pulseMs });
    } catch (err) {
      err.doorOffline = wasOffline || isOfflineError(err);
      throw err;
    }
  }

  let verdict = null;
  let attemptedOn = false;
  let closedAt = 0;
  let failure = null;

  try {
    attemptedOn = true;
    closedAt = Date.now();
    await setDoorState(door, true);
    console.log(`[${door.label}] relay ON via ${config.doors.provider}`);

    if (config.doors.verifyPulse) {
      await sleep(Math.min(config.doors.verifyDelayMs, pulseMs));
      const remainingMs = Math.max(0, pulseMs - (Date.now() - closedAt));
      if (remainingMs > 0) {
        // A provider read must never keep the relay on beyond the pulse. Leave
        // the slow read to finish harmlessly in the background and move on to
        // the finally block, which sends OFF at the deadline.
        const verificationTimedOut = Symbol('verificationTimedOut');
        const state = await Promise.race([
          readDoorState(doorKey),
          sleep(remainingMs).then(() => verificationTimedOut),
        ]);
        if (state !== verificationTimedOut) verdict = judgePulse(state);
      }
    }
  } catch (err) {
    failure = err;
  } finally {
    // Once ON has been attempted, always make a best effort to send OFF. The ON
    // request can time out after the provider delivered it, so even a rejected
    // promise is not proof the relay stayed off. A hard process kill cannot run
    // a finally block, so initializeDoors() sends another OFF after a restart.
    if (attemptedOn) {
      if (closedAt) {
        const heldMs = Date.now() - closedAt;
        if (heldMs < pulseMs) await sleep(pulseMs - heldMs);
      }
      try {
        await setDoorState(door, false);
        console.log(`[${door.label}] relay OFF via ${config.doors.provider}`);
      } catch (offError) {
        if (failure) failure.offError = offError;
        else failure = offError;
      }
    }
  }

  if (failure) {
    failure.doorOffline = wasOffline || isOfflineError(failure);
    throw failure;
  }

  if (verdict === 'switched') {
    if (wasOffline) {
      console.log(`[${door.label}] reported offline but the relay switched - status was stale`);
    }
    return { simulated: false, unconfirmed: false, reason: null };
  }

  if (verdict === 'no_switch') {
    console.warn(`[${door.label}] command was accepted but the relay never switched`);
    return { simulated: false, unconfirmed: true, reason: 'relay_did_not_switch' };
  }

  if (verdict === 'offline') {
    console.warn(`[${door.label}] gone by the time the pulse was checked`);
    return { simulated: false, unconfirmed: true, reason: 'door_offline' };
  }

  if (wasOffline) {
    console.log(`[${door.label}] command sent to a door reading offline - unconfirmed`);
    return { simulated: false, unconfirmed: true, reason: 'door_offline' };
  }
  return { simulated: false, unconfirmed: false, reason: null };
}

/** Make a stuck relay safe after a process or machine restart. */
async function initializeDoors() {
  if (!homeAssistant) return;
  await Promise.all(
    Object.values(DOORS)
      .filter(isConfigured)
      .map(async (door) => {
        try {
          await setDoorState(door, false);
          console.log(`[${door.label}] startup safety: relay OFF`);
        } catch (err) {
          console.warn(`[${door.label}] startup safety OFF failed:`, err.message);
        }
      })
  );
}

module.exports = {
  DOORS,
  listDoors,
  checkDoorOnline,
  readDoorState,
  triggerDoor,
  initializeDoors,
};
