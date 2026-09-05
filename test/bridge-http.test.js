const http = require('http');
const express = require('express');
const { DoorBridgeCoordinator } = require('../src/bridge/coordinator');
const { createBridgeRouter } = require('../src/http/routes/bridge');

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
  console.log('\n-- Railway bridge HTTP API --');

  const coordinator = new DoorBridgeCoordinator({
    token: 'http-test-token',
    pollWaitMs: 100,
    claimTimeoutMs: 200,
    resultTimeoutMs: 200,
  });
  const app = express();
  app.use(express.json());
  app.use('/internal/door-bridge', createBridgeRouter(coordinator));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/internal/door-bridge`;

  const unauthorized = await fetch(`${baseUrl}/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'building-pc' }),
  });
  check('rejects a poll without the bridge token', unauthorized.status === 401);

  const headers = {
    Authorization: 'Bearer http-test-token',
    'Content-Type': 'application/json',
  };
  const pollResponse = fetch(`${baseUrl}/poll`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: 'building-pc',
      status: { doors: { front: { online: true, state: 'off' } } },
    }),
  });
  while (!coordinator.isAgentOnline()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  const resultPromise = coordinator.enqueuePulse({ door: 'front', pulseMs: 1000 });
  const pollPayload = await (await pollResponse).json();
  check('returns the queued job over the waiting poll', pollPayload.job?.door === 'front');

  const resultResponse = await fetch(`${baseUrl}/jobs/${pollPayload.job.id}/result`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: 'building-pc',
      result: { ok: true, unconfirmed: false },
    }),
  });
  check('accepts the matching job result', resultResponse.status === 200);
  check('resolves the original Railway command', (await resultPromise).unconfirmed === false);

  const repeated = await fetch(`${baseUrl}/jobs/${pollPayload.job.id}/result`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: 'building-pc', result: { ok: true } }),
  });
  check('rejects a repeated result for the same job', repeated.status === 410);

  coordinator.close();
  await new Promise((resolve) => server.close(resolve));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
