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
 * Everything Tuya will tell us about the relay in one call: whether it thinks
 * the device is reachable, and the switch state the device itself last
 * reported.
 *
 * The two are worth different amounts. `online` is a heartbeat and lags
 * reality by minutes in both directions. `dp` is what the hardware said about
 * itself, which is the closest thing to a witness this system has.
 *
 * @returns {Promise<{online: boolean|null, dp: *}|null>} null means the call
 *   failed. `dp` undefined means the response carried no state for our switch -
 *   nothing to read, as opposed to a switch that read false.
 */
async function readDoorState(doorKey) {
  const door = DOORS[doorKey];
  if (!door?.deviceId) return null;

  try {
    const result = await tuya.request('GET', `/v1.0/iot-03/devices/${door.deviceId}`);
    const status = Array.isArray(result?.status) ? result.status : null;
    return {
      online: typeof result?.online === 'boolean' ? result.online : null,
      dp: status ? status.find((point) => point.code === door.dpCode)?.value : undefined,
    };
  } catch (err) {
    console.warn(`[${door.label}] state read failed:`, err.message);
    return null;
  }
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
  const state = await readDoorState(doorKey);
  return state ? state.online : null;
}

/**
 * Read a post-pulse state as a verdict on whether the relay actually switched.
 *
 * @returns {'switched'|'offline'|'no_switch'|null} null means unverifiable -
 *   the read failed, or the response carried no state for this switch. Never
 *   guess in that case: a false alarm on a working door teaches people to
 *   ignore the question.
 */
function judgePulse(state) {
  if (!state) return null;
  if (state.dp === undefined) return null;
  // Not there to have switched, whatever it last reported about itself.
  if (state.online === false) return 'offline';
  return state.dp === true ? 'switched' : 'no_switch';
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
// an open.
//
// Nor is a healthy `online` flag. Tuya only marks a device offline after a
// heartbeat timeout, so for the minutes between a relay dying and Tuya
// noticing, every reading says the door is fine and every command is accepted.
// That window is where a confident "opened" is most likely to be a lie. So
// after switching on we read the relay's own reported state back: the device
// saying switch_1 is closed is evidence, where the cloud's receipt is not.
//
// Returns { simulated, unconfirmed, reason }. `unconfirmed` means exactly one
// thing: nothing here proves the door opened. Callers must not report those as
// a plain success - only a person at the door can settle it.
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

  const commandsPath = `/v1.0/iot-03/devices/${door.deviceId}/commands`;
  let verdict = null;

  try {
    await tuya.request('POST', commandsPath, {
      commands: [{ code: door.dpCode, value: true }],
    });
    // Timed from here, not from before the request: the relay is closed once
    // the command lands, and the door expects to be held for pulseMs after
    // that. Counting the request latency into the hold would quietly shorten
    // every pulse.
    const closedAt = Date.now();
    console.log(`[${door.label}] relay ON`);

    // Look while the relay is still held closed - that is the only moment the
    // device has anything to report. The remaining wait is trimmed by however
    // long the read took, so verifying never lengthens the pulse.
    if (config.doors.verifyPulse) {
      await sleep(Math.min(config.doors.verifyDelayMs, pulseMs));
      verdict = judgePulse(await readDoorState(doorKey));
    }

    const heldMs = Date.now() - closedAt;
    if (heldMs < pulseMs) await sleep(pulseMs - heldMs);

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

  // The relay reporting the switch outranks the offline flag that preceded it:
  // hardware describing itself beats a heartbeat that may simply be late.
  if (verdict === 'switched') {
    if (wasOffline) {
      console.log(`[${door.label}] reported offline but the relay switched - flag was stale`);
    }
    return { simulated: false, unconfirmed: false, reason: null };
  }

  if (verdict === 'no_switch') {
    console.warn(`[${door.label}] Tuya accepted the command but the relay never switched`);
    return { simulated: false, unconfirmed: true, reason: 'relay_did_not_switch' };
  }

  if (verdict === 'offline') {
    console.warn(`[${door.label}] gone by the time the pulse was checked`);
    return { simulated: false, unconfirmed: true, reason: 'door_offline' };
  }

  // Unverifiable: the read failed, the response carried no switch state, or
  // verification is turned off. Fall back to what the flag said - claiming an
  // open we cannot see is the whole bug, but so is doubting every open on a
  // door that has given us no reason to.
  if (wasOffline) {
    console.log(`[${door.label}] command sent to a door reading offline - unconfirmed`);
    return { simulated: false, unconfirmed: true, reason: 'door_offline' };
  }
  return { simulated: false, unconfirmed: false, reason: null };
}

module.exports = { DOORS, listDoors, checkDoorOnline, readDoorState, triggerDoor };
