const { config } = require('../config');
const { TuyaCloudClient } = require('./tuya-cloud');

const tuya = new TuyaCloudClient(config.tuya);

// The inner door is a smart lock (Tuya category "jtmspro"), not a plain relay switch.
// Locks don't expose a simple DP for remote unlock - the app uses Tuya's separate,
// ticket-based Smart Lock unlock flow. That's still out of scope (see README).
const DOORS = {
  front: {
    label: 'Front door',
    deviceId: config.doors.frontDeviceId,
    dpCode: 'switch_1',
  },
};

function listDoors() {
  return Object.entries(DOORS).map(([key, door]) => ({
    key,
    label: door.label,
    configured: Boolean(door.deviceId),
  }));
}

/**
 * Is the door's relay currently reachable, as far as Tuya knows?
 *
 * @returns {Promise<boolean|null>} null means "we couldn't find out" - the
 *   status call itself failed. That is not the same as offline and must not be
 *   treated as one: a hiccup talking to Tuya would otherwise read as a dead
 *   door on every single open.
 */
async function checkDoorOnline(doorKey) {
  const door = DOORS[doorKey];
  if (!door?.deviceId) return null;

  try {
    const result = await tuya.request('GET', `/v1.0/iot-03/devices/${door.deviceId}`);
    return typeof result?.online === 'boolean' ? result.online : null;
  } catch (err) {
    console.warn(`[${door.label}] online check failed:`, err.message);
    return null;
  }
}

// Secondary evidence only. The status endpoint's `online` flag is the signal we
// actually trust; these codes let a command that fails on its own still be
// reported as an offline door. Unverified against a live device, so nothing
// depends on the list being right or complete - being wrong here costs a
// generic error message, not a wrong decision.
const OFFLINE_ERROR_CODES = new Set([2007, 2009]);

function isOfflineError(err) {
  return OFFLINE_ERROR_CODES.has(Number(err?.tuyaCode));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The physical relay is momentary: switch on, wait, switch off. Confirmed
// against device logs (~1s) - see README.
//
// `simulate` short-circuits before any Tuya call. It lives here rather than in
// the callers so that every path - WhatsApp command and panel button alike -
// honours it; there is no way to open the door that bypasses this check.
//
// Before pulsing we ask Tuya whether the relay is even reachable, and on a
// negative answer we wait and ask again. But an offline reading never cancels
// the open: Tuya's flag is heartbeat-based and lags reality by minutes in both
// directions, so refusing on it alone would lock people out of a door that
// works. We try anyway.
//
// What we cannot do is claim it worked. Tuya acknowledges a command for a
// device that is unplugged - the cloud confirms it received the request, never
// that the relay acted on it - so a resolved promise here is not evidence of
// an open. `wasOffline` says exactly that: the command went out blind, and
// whether the door moved is still an open question. Callers must not report it
// as a plain success; only a human at the door can settle it.
async function triggerDoor(doorKey, { pulseMs = config.doors.relayPulseMs, simulate = false } = {}) {
  const door = DOORS[doorKey];
  if (!door) {
    throw new Error(`Unknown or unsupported door: ${doorKey}`);
  }
  if (!door.deviceId) {
    throw new Error(`${door.label} is not configured (missing device id in .env)`);
  }

  if (simulate) {
    console.log(`[${door.label}] TEST MODE - pretending to pulse the relay, nothing was sent`);
    return { simulated: true, wasOffline: false };
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

  const commandsPath = `/v1.0/iot-03/devices/${door.deviceId}/commands`;

  try {
    await tuya.request('POST', commandsPath, {
      commands: [{ code: door.dpCode, value: true }],
    });
    console.log(`[${door.label}] relay ON`);

    await sleep(pulseMs);

    await tuya.request('POST', commandsPath, {
      commands: [{ code: door.dpCode, value: false }],
    });
    console.log(`[${door.label}] relay OFF`);
  } catch (err) {
    // Two independent ways to conclude the door is unreachable: the status
    // endpoint told us twice, or the command itself came back with an offline
    // code. Either one earns the specific message and the admin alert.
    err.doorOffline = wasOffline || isOfflineError(err);
    throw err;
  }

  if (wasOffline) {
    console.log(`[${door.label}] command sent to a door reading offline - unconfirmed`);
  }

  return { simulated: false, wasOffline };
}

module.exports = { DOORS, listDoors, checkDoorOnline, triggerDoor };
