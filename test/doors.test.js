const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Deterministic and fast: a fixed device id so the door is always "configured",
// and a recheck delay short enough that the offline path doesn't add seconds to
// the suite. Both are read by config.js at require time, so they must be set
// before anything below is loaded.
process.env.DOOR_FRONT_DEVICE_ID = 'test-device';
process.env.DOOR_PROVIDER = 'tuya';
process.env.DOOR_OFFLINE_RECHECK_MS = '10';
process.env.DOOR_VERIFY_DELAY_MS = '1';

const Module = require('module');

const tuyaPath = path.resolve(__dirname, '../src/doors/tuya-cloud.js');
const pushPath = path.resolve(__dirname, '../src/notify/push.js');
const clientPath = path.resolve(__dirname, '../src/whatsapp/client.js');

// What the fake Tuya answers with, rewritten per scenario.
const tuya = {
  online: true,
  // Answers for consecutive status calls, when a scenario needs the door's
  // reachability to change between the first check and the re-check. Falls back
  // to `online` once drained.
  onlineQueue: [],
  statusCalls: 0,
  commands: [],
  failCommandWith: null,
  failStatus: false,
  // What the relay reports about its own switch. `true` once the ON command has
  // landed is a device that really moved; leaving it false is one that didn't.
  reportsSwitch: true,
  // A device whose response carries no DP state at all - nothing to verify.
  omitStatus: false,
  switchState: false,
};

const push = { delivered: 0, sent: [] };
const whatsapp = { ready: true, sent: [] };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent);
  } catch {
    resolved = null;
  }

  if (resolved === tuyaPath) {
    return {
      TuyaCloudClient: class {
        async request(method, reqPath, body) {
          if (method === 'GET') {
            tuya.statusCalls += 1;
            if (tuya.failStatus) throw new Error('network down');
            const online = tuya.onlineQueue.length ? tuya.onlineQueue.shift() : tuya.online;
            if (tuya.omitStatus) return { online };
            return { online, status: [{ code: 'switch_1', value: tuya.switchState }] };
          }
          tuya.commands.push(body.commands[0].value);
          if (tuya.failCommandWith) {
            const err = new Error('Tuya API error: command rejected');
            err.tuyaCode = tuya.failCommandWith;
            throw err;
          }
          // A relay that acts on the command reports the new state back. One
          // that has silently died keeps reporting whatever it last said.
          if (tuya.reportsSwitch) tuya.switchState = body.commands[0].value;
          return {};
        }
      },
    };
  }

  if (resolved === pushPath) {
    return {
      isPushConfigured: () => true,
      publicKey: () => 'stub',
      sendPush: async (payload) => {
        push.sent.push(payload);
        return push.delivered;
      },
    };
  }

  if (resolved === clientPath) {
    return {
      isReady: () => whatsapp.ready,
      getClient: () => ({
        sendMessage: async (chatId, text) => whatsapp.sent.push({ chatId, text }),
      }),
    };
  }

  return realLoad(request, parent, isMain);
};

const { triggerDoor, checkDoorOnline } = require('../src/doors/door-service');
const {
  reportDoorOffline,
  reportDoorConfirmedOffline,
  reportDoorOnline,
  offlineDoorKeys,
} = require('../src/doors/offline-alert');
const { bus, EVENTS } = require('../src/events');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function reset() {
  tuya.online = true;
  tuya.onlineQueue = [];
  tuya.statusCalls = 0;
  tuya.commands = [];
  tuya.failCommandWith = null;
  tuya.failStatus = false;
  tuya.reportsSwitch = true;
  tuya.omitStatus = false;
  tuya.switchState = false;
  push.delivered = 0;
  push.sent = [];
  whatsapp.ready = true;
  whatsapp.sent = [];
}

async function attempt(options = {}) {
  try {
    return { result: await triggerDoor('front', { pulseMs: 10, ...options }) };
  } catch (err) {
    return { err };
  }
}

async function main() {
  console.log('\n-- reachability check --');

  reset();
  let { result } = await attempt();
  // Once before pulsing to see if it is reachable, once during to see whether
  // it actually switched.
  check('an online door is checked before and during the pulse', tuya.statusCalls === 2);
  check('the relay is pulsed on then off', JSON.stringify(tuya.commands) === '[true,false]');
  check('a relay that reports the switch is a confirmed open', result.unconfirmed === false);

  reset();
  // Down on the first look, up on the second: the gap-in-the-heartbeat case the
  // re-check exists for.
  tuya.onlineQueue = [false, true];
  ({ result } = await attempt());
  check('a door that answers on the re-check is checked twice first', tuya.statusCalls === 3);
  check('recovering on the re-check is not treated as an outage', result.unconfirmed === false);
  check('it still opens', JSON.stringify(tuya.commands) === '[true,false]');

  reset();
  tuya.online = false;
  ({ result } = await attempt());
  check('a door offline twice is still attempted', JSON.stringify(tuya.commands) === '[true,false]');
  // Tuya acknowledges commands for unplugged devices, so the call coming back
  // clean is not evidence of an open. It must say so rather than claim one.
  check('a command sent to an offline door is unconfirmed', result.unconfirmed === true);
  check('  and says why', result.reason === 'door_offline', result.reason);

  console.log('\n-- the lie the offline flag cannot catch --');

  // The window this exists for: Tuya still reports the device as online,
  // because it only gives up after a heartbeat timeout, and it accepts the
  // command happily. The relay is the only thing that knows it never moved.
  reset();
  tuya.reportsSwitch = false;
  ({ result } = await attempt());
  check('a relay that never switches is still commanded', JSON.stringify(tuya.commands) === '[true,false]');
  check('an accepted command is not an open', result.unconfirmed === true);
  check('  and names the relay, not the connection', result.reason === 'relay_did_not_switch', result.reason);

  // Fail soft: doubting every open on a device that told us nothing would be
  // its own kind of wrong.
  reset();
  tuya.omitStatus = true;
  ({ result } = await attempt());
  check('a device reporting no switch state is left alone', result.unconfirmed === false);

  reset();
  tuya.failStatus = true;
  ({ result } = await attempt());
  check('a failed status call is not read as offline', result.unconfirmed === false);
  check('and the open proceeds', JSON.stringify(tuya.commands) === '[true,false]');

  reset();
  ({ result } = await attempt({ simulate: true }));
  check('test mode touches Tuya not at all', tuya.statusCalls === 0 && tuya.commands.length === 0);
  check('test mode reports itself', result.simulated === true);

  console.log('\n-- classifying failures --');

  reset();
  tuya.online = false;
  tuya.failCommandWith = 1004;
  let { err } = await attempt();
  check('offline twice then a failed command is flagged offline', err.doorOffline === true);

  reset();
  tuya.failCommandWith = 2007;
  ({ err } = await attempt());
  check("an online door failing with Tuya's offline code is flagged offline", err.doorOffline === true);

  reset();
  tuya.failCommandWith = 1004;
  ({ err } = await attempt());
  check('an unrelated failure is not blamed on the door being offline', err.doorOffline === false);
  check('the error still propagates', /command rejected/.test(err.message));

  reset();
  check('an unconfigured door has no reachability answer', (await checkDoorOnline('nope')) === null);

  console.log('\n-- alerting --');

  const settings = { adminAlertPhone: '0549212025', defaultCountryCode: '213' };
  const events = [];
  bus.on(EVENTS.DOOR_OFFLINE, (e) => events.push(['offline', e.door]));
  bus.on(EVENTS.DOOR_ONLINE, (e) => events.push(['online', e.door]));

  reset();
  push.delivered = 1;
  await reportDoorOffline({ door: 'front', label: 'Front door', settings, actor: 'Sam' });
  check('a confirmed outage pushes to the browser', push.sent.length === 1);
  check('WhatsApp stays quiet when push was delivered', whatsapp.sent.length === 0);
  check('the door is latched offline', offlineDoorKeys().includes('front'));

  await reportDoorOffline({ door: 'front', label: 'Front door', settings, actor: 'Alex' });
  check('a second attempt during the same outage does not re-notify', push.sent.length === 1);
  check('but the dashboard hears every attempt', events.filter((e) => e[0] === 'offline').length === 2);

  reportDoorOnline({ door: 'front', label: 'Front door' });
  check('a successful open clears the latch', offlineDoorKeys().length === 0);
  check('and tells the dashboard', events.some((e) => e[0] === 'online'));

  await reportDoorOffline({ door: 'front', label: 'Front door', settings });
  check('a new outage alerts again', push.sent.length === 2);

  reset();
  reportDoorOnline({ door: 'front', label: 'Front door' });
  push.delivered = 0;
  await reportDoorOffline({ door: 'front', label: 'Front door', settings, actor: 'Sam' });
  check('with no browser subscribed it falls back to WhatsApp', whatsapp.sent.length === 1);
  check(
    'the fallback goes to the normalised admin number',
    whatsapp.sent[0]?.chatId === '213549212025@c.us'
  );

  reset();
  reportDoorOnline({ door: 'front', label: 'Front door' });
  push.delivered = 0;
  whatsapp.ready = false;
  await reportDoorOffline({ door: 'front', label: 'Front door', settings });
  check('a disconnected WhatsApp does not throw', whatsapp.sent.length === 0);

  reset();
  reportDoorOnline({ door: 'front', label: 'Front door' });
  push.delivered = 0;
  await reportDoorOffline({ door: 'front', label: 'Front door', settings: { adminAlertPhone: '' } });
  check('no configured number means no fallback attempt', whatsapp.sent.length === 0);

  // Test mode sends no command, so a simulated open proves nothing about the
  // door. Clearing the latch on one would silently drop a live outage.
  reset();
  push.delivered = 1;
  await reportDoorOffline({ door: 'front', label: 'Front door', settings });
  reportDoorOnline({ door: 'front', label: 'Front door', simulated: true });
  check('a simulated open leaves a real outage latched', offlineDoorKeys().includes('front'));
  reportDoorOnline({ door: 'front', label: 'Front door' });
  check('a real open then clears it', offlineDoorKeys().length === 0);

  console.log('\n-- confirmed by a person --');

  // A member saying "it did not open" is the only hard evidence of an outage
  // there is, so it alerts even though the probe already latched the door.
  reset();
  push.delivered = 1;
  await reportDoorOffline({ door: 'front', label: 'Front door', settings, actor: 'Sam' });
  await reportDoorConfirmedOffline({ door: 'front', label: 'Front door', settings, actor: 'Sam' });
  check('a confirmed outage alerts on top of the probe', push.sent.length === 2);
  check('  and says it was confirmed', /ne s'ouvre pas/.test(push.sent[1]?.title || ''));

  await reportDoorConfirmedOffline({ door: 'front', label: 'Front door', settings, actor: 'Alex' });
  check('a second person confirming does not re-notify', push.sent.length === 2);

  reportDoorOnline({ door: 'front', label: 'Front door' });
  reset();
  push.delivered = 1;
  await reportDoorConfirmedOffline({ door: 'front', label: 'Front door', settings, actor: 'Sam' });
  check('a new outage can be confirmed again', push.sent.length === 1);
  check('  and confirming latches the door for the panel', offlineDoorKeys().includes('front'));
  reportDoorOnline({ door: 'front', label: 'Front door' });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
