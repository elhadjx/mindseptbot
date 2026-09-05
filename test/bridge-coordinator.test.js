const { DoorBridgeCoordinator } = require('../src/bridge/coordinator');

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
  console.log('\n-- Railway door bridge coordinator --');

  const auth = new DoorBridgeCoordinator({ token: 'correct-secret' });
  check('accepts the exact bearer token', auth.authenticate('Bearer correct-secret'));
  check('rejects a wrong bearer token', !auth.authenticate('Bearer wrong-secret'));
  check('rejects a missing bearer token', !auth.authenticate(undefined));

  let now = 1000;
  const status = new DoorBridgeCoordinator({
    token: 'token',
    heartbeatTtlMs: 50,
    now: () => now,
  });
  status.noteHeartbeat('building-pc', { doors: { front: { online: true, state: 'off' } } });
  check('a fresh heartbeat exposes the local door state', status.getDoorState('front').dp === false);
  now += 51;
  check('an expired heartbeat marks the agent offline', status.getDoorState('front').online === false);

  const offline = new DoorBridgeCoordinator({ token: 'token' });
  const offlineError = await catches(offline.enqueuePulse({ door: 'front', pulseMs: 1000 }));
  check('does not queue a command for an offline agent', offlineError?.bridgeCode === 'bridge_agent_offline');

  const cancelled = new DoorBridgeCoordinator({ token: 'token', pollWaitMs: 1000 });
  const cancellation = new AbortController();
  const cancelledPoll = cancelled.poll({
    agentId: 'building-pc',
    status: { doors: { front: { online: true, state: 'off' } } },
    signal: cancellation.signal,
  });
  cancellation.abort();
  check('removes a poll when its HTTP connection closes', (await cancelledPoll) === null);

  const coordinator = new DoorBridgeCoordinator({
    token: 'token',
    pollWaitMs: 10,
    claimTimeoutMs: 30,
    resultTimeoutMs: 30,
  });
  const polling = coordinator.poll({
    agentId: 'building-pc',
    status: { doors: { front: { online: true, state: 'off' } } },
  });
  const resultPromise = coordinator.enqueuePulse({ door: 'front', pulseMs: 1000 });
  const job = await polling;
  check('delivers an atomic pulse job to the waiting agent', job?.type === 'pulse' && job.pulseMs === 1000);

  const secondPoll = await coordinator.poll({
    agentId: 'building-pc',
    status: { doors: { front: { online: true, state: 'off' } } },
  });
  check('never redelivers a claimed opening command', secondPoll === null);

  check(
    'accepts a result only from the claiming agent',
    coordinator.complete({
      agentId: 'building-pc',
      jobId: job.id,
      result: { ok: true, unconfirmed: false },
    })
  );
  const result = await resultPromise;
  check('returns the local result to the Railway caller', result.unconfirmed === false);
  check(
    'a completed job cannot be completed twice',
    !coordinator.complete({ agentId: 'building-pc', jobId: job.id, result: { ok: true } })
  );

  const expiring = new DoorBridgeCoordinator({
    token: 'token',
    claimTimeoutMs: 10,
    resultTimeoutMs: 20,
  });
  expiring.noteHeartbeat('building-pc', { doors: { front: { online: true, state: 'off' } } });
  const expiredError = await catches(expiring.enqueuePulse({ door: 'front', pulseMs: 1000 }));
  check('expires an unclaimed command instead of retrying it', expiredError?.bridgeCode === 'bridge_claim_timeout');

  const failing = new DoorBridgeCoordinator({ token: 'token', pollWaitMs: 10 });
  const failingPoll = failing.poll({
    agentId: 'building-pc',
    status: { doors: { front: { online: true, state: 'off' } } },
  });
  const failingResult = failing.enqueuePulse({ door: 'front', pulseMs: 1000 });
  const failingJob = await failingPoll;
  failing.complete({
    agentId: 'building-pc',
    jobId: failingJob.id,
    result: { ok: false, error: { code: 'local_actuation_failed', message: 'HA unavailable' } },
  });
  const localError = await catches(failingResult);
  check('propagates a local actuation failure', localError?.message === 'HA unavailable');
  check('classifies a local actuation failure as offline', localError?.doorOffline === true);

  const badPulse = await catches(
    coordinator.enqueuePulse({ door: 'front', pulseMs: 5000 })
  );
  check('rejects an unsafe pulse duration', badPulse?.bridgeCode === 'invalid_pulse');
  check('does not misclassify invalid input as an outage', badPulse?.doorOffline === false);

  coordinator.close();
  cancelled.close();
  expiring.close();
  failing.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
