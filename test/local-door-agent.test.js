const { LocalDoorActuator } = require('../src/bridge/local-door');
const { BridgeApiClient, DoorAgent } = require('../src/bridge/agent');

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

async function catches(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

async function main() {
  console.log('\n-- Windows local door agent --');

  const ha = {
    state: 'off',
    commands: [],
    failOn: false,
    failOff: false,
    onDelayMs: 0,
    async getState() {
      return { state: this.state };
    },
    async setState(entityId, enabled) {
      this.commands.push({ entityId, enabled, at: Date.now() });
      if (enabled && this.onDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.onDelayMs));
      }
      if ((enabled && this.failOn) || (!enabled && this.failOff)) {
        const err = new Error('Home Assistant unavailable');
        err.connectionError = true;
        throw err;
      }
      this.state = enabled ? 'on' : 'off';
    },
  };
  const actuator = new LocalDoorActuator({
    homeAssistant: ha,
    entityId: 'switch.front_door',
  });

  await actuator.ensureOff();
  check('startup explicitly sends OFF', ha.commands.at(-1)?.enabled === false);

  ha.commands = [];
  const result = await actuator.pulse({ door: 'front', pulseMs: 100 });
  check('pulses ON then OFF locally', ha.commands[0]?.enabled === true && ha.commands[1]?.enabled === false);
  check('leaves the relay OFF', ha.state === 'off');
  check('reports a successful local pulse', result.unconfirmed === false);

  ha.commands = [];
  ha.onDelayMs = 200;
  await actuator.pulse({ door: 'front', pulseMs: 100 });
  check(
    'a slow ON acknowledgement does not add another pulse interval',
    ha.commands[1].at - ha.commands[0].at < 250
  );
  ha.onDelayMs = 0;

  ha.commands = [];
  ha.failOn = true;
  const onError = await catches(actuator.pulse({ door: 'front', pulseMs: 100 }));
  check('a failed ON still attempts OFF', ha.commands.at(-1)?.enabled === false);
  check('marks an actuation failure as a door outage', onError?.doorOffline === true);
  ha.failOn = false;

  ha.commands = [];
  ha.failOff = true;
  const offError = await catches(actuator.pulse({ door: 'front', pulseMs: 100 }));
  check('surfaces a failed safety OFF', offError?.doorOffline === true);
  ha.failOff = false;

  const invalid = await catches(actuator.pulse({ door: 'front', pulseMs: 5000 }));
  check('rejects a pulse above the local safety limit', /between 100 and 2000/.test(invalid?.message));

  let pulses = 0;
  const agent = new DoorAgent({
    api: {},
    actuator: {
      async pulse() {
        pulses++;
        return { simulated: false, unconfirmed: false, reason: null };
      },
    },
    agentId: 'building-pc',
  });
  const job = {
    id: 'one-job',
    type: 'pulse',
    door: 'front',
    pulseMs: 1000,
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  };
  const first = await agent._resultFor(job);
  const duplicate = await agent._resultFor(job);
  check('executes a job id only once in one agent process', pulses === 1);
  check('returns the cached result for a duplicate job id', first === duplicate);

  await agent._resultFor({ ...job, id: 'expired', expiresAt: new Date(0).toISOString() });
  check('does not pulse an expired command', pulses === 1);

  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, job: null }), { status: 200 });
  };
  const api = new BridgeApiClient({
    serverUrl: 'https://mindsept.example',
    token: 'bridge-secret',
    requestTimeoutMs: 1000,
  });
  await api.poll('building-pc', { doors: { front: { online: true, state: 'off' } } });
  await api.complete('building-pc', 'job/id', { ok: true });
  check('polls the Railway internal bridge endpoint', calls[0]?.url.endsWith('/internal/door-bridge/poll'));
  check('sends the bridge secret only as a bearer header', calls.every((call) => call.options.headers.Authorization === 'Bearer bridge-secret'));
  check('URL-encodes the job id in result requests', calls[1]?.url.endsWith('/jobs/job%2Fid/result'));

  global.fetch = async () => new Response('{"error":"unauthorized"}', { status: 401 });
  const apiError = await catches(api.poll('building-pc', {}));
  check('does not expose the bridge token in HTTP errors', !apiError?.message.includes('bridge-secret'));
  global.fetch = realFetch;

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
