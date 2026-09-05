const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

process.env.DOOR_PROVIDER = 'bridge';
process.env.DOOR_BRIDGE_TOKEN = 'test-bridge-token';
process.env.DOOR_BRIDGE_AGENT_ID = 'building-pc';
process.env.DOOR_OFFLINE_RECHECK_MS = '1';

const Module = require('module');
const runtimePath = path.resolve(__dirname, '../src/bridge/runtime.js');

const bridge = {
  enabled: true,
  state: { online: true, dp: false },
  calls: [],
  error: null,
  getDoorState() {
    return this.state;
  },
  async enqueuePulse(command) {
    this.calls.push(command);
    if (this.error) throw this.error;
    return { simulated: false, unconfirmed: false, reason: null };
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent);
  } catch {
    resolved = null;
  }
  if (resolved === runtimePath) return { bridgeCoordinator: bridge };
  return realLoad(request, parent, isMain);
};

const { listDoors, checkDoorOnline, triggerDoor } = require('../src/doors/door-service');

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

async function main() {
  console.log('\n-- Railway bridge door provider --');

  check('front door is configured by the bridge token', listDoors()[0]?.configured === true);
  check('uses the Windows heartbeat for reachability', (await checkDoorOnline('front')) === true);

  let result = await triggerDoor('front', { pulseMs: 1000 });
  check('sends one atomic pulse job', bridge.calls.length === 1);
  check(
    'passes only the door and bounded pulse duration',
    JSON.stringify(bridge.calls[0]) === JSON.stringify({ door: 'front', pulseMs: 1000 })
  );
  check('returns the local agent result', result.unconfirmed === false);

  bridge.calls = [];
  result = await triggerDoor('front', { pulseMs: 1000, simulate: true });
  check('test mode sends no bridge job', bridge.calls.length === 0);
  check('test mode still reports itself', result.simulated === true);

  bridge.state = { online: false, dp: undefined };
  bridge.calls = [];
  result = await triggerDoor('front', { pulseMs: 1000 });
  check('an offline heartbeat does not suppress the attempt', bridge.calls.length === 1);
  check('a completed local pulse outranks the stale heartbeat', result.unconfirmed === false);

  bridge.state = { online: true, dp: false };
  const error = new Error('Local agent disappeared');
  error.bridgeCode = 'bridge_result_timeout';
  error.connectionError = true;
  bridge.error = error;
  let thrown;
  try {
    await triggerDoor('front', { pulseMs: 1000 });
  } catch (err) {
    thrown = err;
  }
  check('propagates bridge failures', thrown === error);
  check('classifies bridge failures as door-offline errors', thrown?.doorOffline === true);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
