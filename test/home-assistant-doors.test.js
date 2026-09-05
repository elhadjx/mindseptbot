const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

process.env.DOOR_PROVIDER = 'home_assistant';
process.env.HOME_ASSISTANT_TOKEN = 'test-token';
process.env.HOME_ASSISTANT_FRONT_ENTITY_ID = 'switch.front_door';
process.env.DOOR_OFFLINE_RECHECK_MS = '1';
process.env.DOOR_VERIFY = 'on';
process.env.DOOR_VERIFY_DELAY_MS = '1';

const Module = require('module');
const homeAssistantPath = path.resolve(__dirname, '../src/doors/home-assistant.js');

const ha = {
  available: true,
  reportsSwitch: true,
  state: 'off',
  reads: 0,
  commands: [],
  readError: null,
  commandError: null,
  failOff: false,
  verifyReadDelayMs: 0,
  commandTimes: [],
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent);
  } catch {
    resolved = null;
  }

  if (resolved === homeAssistantPath) {
    return {
      HomeAssistantClient: class {
        async getState() {
          ha.reads += 1;
          if (ha.reads > 1 && ha.verifyReadDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, ha.verifyReadDelayMs));
          }
          if (ha.readError) throw ha.readError;
          return { state: ha.available ? ha.state : 'unavailable' };
        }

        async setState(entityId, enabled) {
          ha.commands.push({ entityId, enabled });
          ha.commandTimes.push(Date.now());
          if (ha.commandError || (ha.failOff && !enabled)) {
            const err = new Error('Home Assistant request failed');
            err.connectionError = true;
            throw err;
          }
          if (ha.available && ha.reportsSwitch) ha.state = enabled ? 'on' : 'off';
        }
      },
    };
  }

  return realLoad(request, parent, isMain);
};

const {
  triggerDoor,
  checkDoorOnline,
  initializeDoors,
} = require('../src/doors/door-service');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function reset() {
  ha.available = true;
  ha.reportsSwitch = true;
  ha.state = 'off';
  ha.reads = 0;
  ha.commands = [];
  ha.readError = null;
  ha.commandError = null;
  ha.failOff = false;
  ha.verifyReadDelayMs = 0;
  ha.commandTimes = [];
}

async function attempt(options = {}) {
  try {
    return { result: await triggerDoor('front', { pulseMs: 10, ...options }) };
  } catch (err) {
    return { err };
  }
}

async function main() {
  console.log('\n-- Home Assistant door provider --');

  reset();
  let { result } = await attempt();
  check('checks state before and during a pulse', ha.reads === 2);
  check('pulses the configured entity on then off', JSON.stringify(ha.commands) === JSON.stringify([
    { entityId: 'switch.front_door', enabled: true },
    { entityId: 'switch.front_door', enabled: false },
  ]));
  check('confirms a relay that reports ON', result?.unconfirmed === false);

  reset();
  ha.available = false;
  ({ result } = await attempt());
  check('still attempts a relay reported unavailable', ha.commands.length === 2);
  check('does not claim the unavailable door opened', result?.reason === 'door_offline');

  reset();
  ha.reportsSwitch = false;
  ({ result } = await attempt());
  check('detects an accepted command with no state change', result?.reason === 'relay_did_not_switch');
  check('still sends OFF after failed verification', ha.commands.at(-1)?.enabled === false);

  reset();
  ha.commandError = true;
  let { err } = await attempt();
  check('classifies a Home Assistant transport failure as offline', err?.doorOffline === true);
  check('a failed ON still gets a safety OFF attempt', ha.commands.at(-1)?.enabled === false);

  reset();
  ha.failOff = true;
  ({ err } = await attempt());
  check('attempts OFF even when that command fails', ha.commands.some((command) => command.enabled === false));
  check('reports a failed safety OFF as an outage', err?.doorOffline === true);

  reset();
  ha.verifyReadDelayMs = 200;
  await attempt({ pulseMs: 30 });
  check(
    'a slow verification read cannot delay the safety OFF',
    ha.commandTimes[1] - ha.commandTimes[0] < 100
  );

  reset();
  ({ result } = await attempt({ simulate: true }));
  check('test mode sends no Home Assistant command', ha.commands.length === 0);
  check('test mode reports itself', result?.simulated === true);

  reset();
  await initializeDoors();
  check('startup explicitly forces the relay OFF', ha.commands.length === 1 && ha.commands[0].enabled === false);

  reset();
  check('an unknown door has no reachability answer', (await checkDoorOnline('unknown')) === null);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
