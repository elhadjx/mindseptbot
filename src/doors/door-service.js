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

// The physical relay is momentary: switch on, wait, switch off. Confirmed
// against device logs (~1s) - see README.
async function triggerDoor(doorKey, { pulseMs = config.doors.relayPulseMs } = {}) {
  const door = DOORS[doorKey];
  if (!door) {
    throw new Error(`Unknown or unsupported door: ${doorKey}`);
  }
  if (!door.deviceId) {
    throw new Error(`${door.label} is not configured (missing device id in .env)`);
  }

  const commandsPath = `/v1.0/iot-03/devices/${door.deviceId}/commands`;

  await tuya.request('POST', commandsPath, {
    commands: [{ code: door.dpCode, value: true }],
  });
  console.log(`[${door.label}] relay ON`);

  await new Promise((resolve) => setTimeout(resolve, pulseMs));

  await tuya.request('POST', commandsPath, {
    commands: [{ code: door.dpCode, value: false }],
  });
  console.log(`[${door.label}] relay OFF`);
}

module.exports = { DOORS, listDoors, triggerDoor };
