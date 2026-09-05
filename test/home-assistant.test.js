const { HomeAssistantClient } = require('../src/doors/home-assistant');

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
  console.log('\n-- Home Assistant REST client --');

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') {
      return new Response(JSON.stringify({ entity_id: 'switch.front_door', state: 'off' }), {
        status: 200,
      });
    }
    return new Response('[]', { status: 200 });
  };

  const client = new HomeAssistantClient({
    baseUrl: 'http://127.0.0.1:8123/',
    accessToken: 'secret-token',
  });
  const state = await client.getState('switch.front_door');
  await client.setState('switch.front_door', true);
  await client.setState('switch.front_door', false);

  check('reads the configured entity state', state.state === 'off');
  check('normalises a trailing slash in the base URL', calls[0].url === 'http://127.0.0.1:8123/api/states/switch.front_door');
  check('sends the bearer token', calls.every((call) => call.options.headers.Authorization === 'Bearer secret-token'));
  check('uses the entity domain and turn_on service', calls[1].url.endsWith('/api/services/switch/turn_on'));
  check('uses turn_off for the safe half of the pulse', calls[2].url.endsWith('/api/services/switch/turn_off'));
  check('sends only the configured entity id', calls[1].options.body === '{"entity_id":"switch.front_door"}');

  global.fetch = async () =>
    new Response(JSON.stringify({ message: 'Invalid access token' }), { status: 401 });
  let authError;
  try {
    await client.getState('switch.front_door');
  } catch (err) {
    authError = err;
  }
  check('keeps the HTTP status on API failures', authError?.homeAssistantStatus === 401);
  check('does not expose the access token in errors', !authError?.message.includes('secret-token'));

  global.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  let connectionError;
  try {
    await client.getState('switch.front_door');
  } catch (err) {
    connectionError = err;
  }
  check('marks transport failures for offline classification', connectionError?.connectionError === true);

  global.fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
