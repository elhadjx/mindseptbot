const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { compileFunction } = require('node:vm');
const { Client, RemoteAuth, Events } = require('whatsapp-web.js');

const filename = path.resolve(__dirname, '../src/whatsapp/client.js');
const source = fs.readFileSync(filename, 'utf8');
const navigationError = () => new Error(
  'Protocol error (Runtime.callFunctionOn): Execution context was destroyed.'
);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Load a fresh module with a fake browser, store, and clock. The actual Client
// destroy() and RemoteAuth destroy() run, but no browser or database is opened.
function harness(attempts = [], { toDataURL = async (qr) => `data:${qr}` } = {}) {
  const instances = [];
  const timers = new Map();
  const bus = new EventEmitter();
  const states = [];
  const messages = [];
  const handled = [];
  const session = { exists: true, deletes: 0 };
  bus.on('state', (state) => states.push(state));
  bus.on('message', (message) => messages.push(message));

  class Store {
    async sessionExists() { return session.exists; }
    async delete() { session.exists = false; session.deletes += 1; }
  }

  class FakeClient extends EventEmitter {
    constructor(options) {
      super();
      this.behavior = attempts[instances.length] || {};
      if (this.behavior.constructorError) throw this.behavior.constructorError;
      this.authStrategy = options.authStrategy;
      this.authStrategy.setup(this);
      this.info = { pushname: 'Test', wid: { user: '123', _serialized: '123@c.us' } };
      this.initializeCalls = 0;
      this.destroyCalls = 0;
      this.logoutCalls = 0;
      this.closeCalls = 0;
      this.connected = false;
      this.startupCancelled = false;
      instances.push(this);
    }

    async initialize() {
      this.initializeCalls += 1;
      this.connected = true;
      this.pupBrowser = {
        isConnected: () => this.connected,
        close: async () => {
          this.closeCalls += 1;
          await this.behavior.close?.(this);
          this.connected = false;
        },
      };
      this.restoredSession = await this.authStrategy.store.sessionExists();
      await this.behavior.initialize?.(this);
    }

    async destroy() {
      this.destroyCalls += 1;
      await Client.prototype.destroy.call(this);
    }

    cancelStartup() {
      this.startupCancelled = true;
    }

    async logout() {
      this.logoutCalls += 1;
      await this.behavior.logout?.(this);
      await this.authStrategy.store.delete();
      this.emit(Events.DISCONNECTED, 'LOGOUT');
      await this.destroy();
    }
  }

  const dependencies = {
    'whatsapp-web.js': { Client: FakeClient, RemoteAuth, Events },
    './startup-client': { StartupClient: FakeClient },
    qrcode: { toDataURL },
    './mongo-session-store': { MongoSessionStore: Store },
    '../config': { config: { whatsapp: {
      clientId: 'lifecycle-test', dataPath: '/tmp/unused-whatsapp-lifecycle-test',
      backupSyncIntervalMs: 60000,
    } } },
    '../db/mongo': { mongoose: {} },
    '../events': { bus, EVENTS: { WA_STATE: 'state', WA_MESSAGE: 'message' } },
    './messages': { mapMessage: (msg) => msg, chatIdFor: (msg) => msg.from },
  };
  const module = { exports: {} };
  compileFunction(source, ['require', 'module', 'setTimeout', 'clearTimeout', 'console'], { filename })(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    (callback, delay) => {
      const timer = { callback, delay };
      timers.set(timer, timer);
      return timer;
    },
    (timer) => timers.delete(timer),
    { log() {}, warn() {}, error() {} }
  );
  const api = module.exports;
  return {
    api, instances, timers, states, messages, handled, session,
    start: () => api.startWhatsApp((msg) => handled.push(msg)),
    nextTimer() {
      assert.equal(timers.size, 1, 'exactly one reconnect must be scheduled');
      return timers.values().next().value;
    },
    async retry() {
      const timer = this.nextTimer();
      timers.delete(timer);
      await timer.callback();
    },
  };
}

test('initial navigation failure is visible, cleaned up, and retried with the saved session', async () => {
  const error = navigationError();
  const h = harness([
    { initialize: async (instance) => {
      instance.emit(Events.AUTHENTICATED);
      instance.emit(Events.REMOTE_SESSION_SAVED);
      throw error;
    } },
    { initialize: async (instance) => instance.emit(Events.READY) },
  ]);
  await assert.rejects(h.start(), error);
  const old = h.instances[0];
  assert.equal(old.destroyCalls, 1);
  assert.equal(old.connected, false);
  assert.equal(old.logoutCalls, 0);
  assert.equal(h.session.deletes, 0);
  assert.equal(h.api.getClient(), null);
  assert.equal(h.api.getState().status, 'disconnected');
  assert.equal(h.api.getState().lastError, error.message);
  assert.equal(h.api.getState().sessionBackedUp, true);
  assert.equal(h.states.at(-1).lastError, error.message);
  assert.equal(h.api.isReady(), false);
  assert.equal(h.nextTimer().delay, 5000);

  await h.retry();
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[1].restoredSession, true);
  assert.equal(h.api.isReady(), true);
  assert.equal(h.api.getState().lastError, null);
  assert.equal(h.timers.size, 0);
  assert.equal(await h.start(), h.instances[1]);
  assert.equal(h.instances.length, 2, 'starting an active client again must not replace it');

  const msg = { from: 'test@c.us', body: 'hello' };
  h.instances[1].emit(Events.MESSAGE_RECEIVED, msg);
  assert.deepEqual(h.handled, [msg]);
  assert.equal(h.messages.length, 1);
});

test('repeated startup failures back off to five minutes and ready resets the delay', async () => {
  const h = harness([
    ...Array.from({ length: 8 }, () => ({ initialize: async () => { throw navigationError(); } })),
    { initialize: async (instance) => instance.emit(Events.READY) },
  ]);
  await assert.rejects(h.start());
  for (const delay of [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
    assert.equal(h.nextTimer().delay, delay);
    await h.retry();
  }
  assert.equal(h.api.isReady(), true);
  assert.equal(h.session.deletes, 0);
  assert.ok(h.instances.slice(0, -1).every((instance) => !instance.connected));
  h.instances.at(-1).emit(Events.DISCONNECTED, 'TIMEOUT');
  h.instances.at(-1).emit(Events.DISCONNECTED, 'TIMEOUT');
  assert.equal(h.nextTimer().delay, 5000);
});

test('concurrent starts share initialization and wait for failed-browser cleanup', async () => {
  const init = deferred();
  const close = deferred();
  const h = harness([{ initialize: () => init.promise, close: () => close.promise }]);
  const first = assert.rejects(h.start(), /Execution context/);
  const second = assert.rejects(h.start(), /Execution context/);
  await flush();
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].initializeCalls, 1);
  init.reject(navigationError());
  await flush();
  assert.equal(h.instances[0].closeCalls, 1);
  assert.equal(h.timers.size, 0);
  const third = assert.rejects(h.start(), /Execution context/);
  assert.equal(h.instances.length, 1);
  h.instances[0].emit(Events.READY);
  assert.equal(h.api.isReady(), false);
  close.resolve();
  await Promise.all([first, second, third]);
  assert.equal(h.nextTimer().delay, 5000);
  await h.retry();
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[0].connected, false);
});

test('cleanup failures retain the old browser and block replacement until it closes', async () => {
  const h = harness([
    {
      initialize: async () => { throw navigationError(); },
      close: async (instance) => {
        if (instance.closeCalls < 3) throw new Error('browser close failed');
      },
    },
    { initialize: async (instance) => instance.emit(Events.READY) },
  ]);
  await assert.rejects(h.start(), /Execution context/);
  const old = h.instances[0];
  assert.equal(h.api.getClient(), old);
  assert.equal(old.connected, true);
  await h.retry();
  assert.equal(h.instances.length, 1);
  assert.equal(h.api.getState().lastError, 'browser close failed');
  assert.equal(h.nextTimer().delay, 10000);
  await h.retry();
  assert.equal(old.connected, false);
  assert.equal(h.instances.length, 2);
  assert.equal(h.api.isReady(), true);
  assert.equal(h.session.deletes, 0);
});

test('retired clients cannot publish late events or finish an old QR conversion', async () => {
  const init = deferred();
  const qr = deferred();
  let qrCalls = 0;
  const h = harness([
    { initialize: () => init.promise },
    { initialize: async (instance) => instance.emit(Events.READY) },
  ], { toDataURL: () => { qrCalls += 1; return qr.promise; } });
  const starting = assert.rejects(h.start());
  await flush();
  const old = h.instances[0];
  old.emit(Events.QR_RECEIVED, 'old-qr');
  init.reject(navigationError());
  await starting;
  await h.retry();
  const snapshot = h.api.getState();
  const stateCount = h.states.length;
  qr.resolve('data:old-qr');
  for (const event of [Events.QR_RECEIVED, Events.AUTHENTICATED, Events.AUTHENTICATION_FAILURE,
    Events.READY, Events.REMOTE_SESSION_SAVED, Events.DISCONNECTED]) {
    old.emit(event, 'late');
  }
  old.emit(Events.MESSAGE_RECEIVED, { from: 'old', body: 'late' });
  old.emit(Events.MESSAGE_CREATE, { fromMe: true, from: 'old', body: 'late' });
  await flush();
  assert.deepEqual(h.api.getState(), snapshot);
  assert.equal(h.states.length, stateCount);
  assert.equal(qrCalls, 1);
  assert.equal(h.messages.length, 0);
  assert.equal(h.handled.length, 0);
  assert.equal(h.timers.size, 0);
});

test('shutdown cancels a pending reconnect, including an already queued callback', async () => {
  const h = harness([{ initialize: async () => { throw navigationError(); } }]);
  await assert.rejects(h.start());
  const timer = h.nextTimer();
  h.api.stopWhatsApp();
  assert.equal(h.timers.size, 0);
  await timer.callback();
  assert.equal(h.instances.length, 1);
  assert.equal(h.timers.size, 0);
});

for (const outcome of ['resolve', 'reject']) {
  test(`shutdown cleans up an in-flight initialization that will ${outcome}`, async () => {
    const init = deferred();
    const h = harness([{ initialize: () => init.promise }]);
    const starting = h.start();
    const result = outcome === 'reject' ? assert.rejects(starting) : starting;
    await flush();
    h.api.stopWhatsApp();
    assert.equal(h.instances[0].startupCancelled, true);
    const stateCount = h.states.length;
    h.instances[0].emit(Events.READY);
    h.instances[0].emit(Events.DISCONNECTED, 'LOGOUT');
    if (outcome === 'reject') init.reject(navigationError());
    else init.resolve();
    await result;
    assert.equal(h.instances[0].connected, false);
    assert.equal(h.api.getClient(), null);
    assert.equal(h.api.isReady(), false);
    assert.equal(h.states.length, stateCount);
    assert.equal(h.timers.size, 0);
    assert.equal(h.session.deletes, 0);
  });
}

test('a disconnect during initialization schedules one replacement after it settles', async () => {
  const init = deferred();
  const h = harness([{ initialize: () => init.promise }]);
  const starting = h.start();
  await flush();
  h.instances[0].emit(Events.DISCONNECTED, 'LOGOUT');
  h.instances[0].emit(Events.READY);
  assert.equal(h.api.getState().status, 'disconnected');
  assert.equal(h.api.isReady(), false);
  assert.equal(h.timers.size, 0);
  init.resolve();
  assert.equal(await starting, null);
  assert.equal(h.nextTimer().delay, 5000);
  await h.retry();
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[0].connected, false);
});

test('constructor errors and non-Error startup rejections are also visible and retried', async () => {
  const constructor = harness([{ constructorError: new Error('invalid client configuration') }]);
  await assert.rejects(constructor.start(), /invalid client configuration/);
  assert.equal(constructor.api.getState().status, 'disconnected');
  assert.equal(constructor.nextTimer().delay, 5000);

  const timeout = harness([{ initialize: async () => { throw 'auth timeout'; } }]);
  await assert.rejects(timeout.start(), (err) => err === 'auth timeout');
  assert.equal(timeout.api.getState().lastError, 'auth timeout');
  assert.equal(timeout.instances[0].connected, false);
  assert.equal(timeout.nextTimer().delay, 5000);
});

test('explicit logout still unlinks, and concurrent starts wait until unlinking finishes', async () => {
  const logout = deferred();
  const h = harness([{
    initialize: async (instance) => instance.emit(Events.READY),
    logout: () => logout.promise,
  }]);
  await h.start();
  const unlinking = h.api.logoutWhatsApp();
  const duplicate = h.api.logoutWhatsApp();
  const restarting = h.start();
  await flush();
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].logoutCalls, 1);
  assert.equal(h.api.isReady(), false);
  assert.equal(h.timers.size, 0);
  logout.resolve();
  await Promise.all([unlinking, duplicate, restarting]);
  assert.equal(h.session.deletes, 1);
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[0].connected, false);
  assert.equal(h.instances[1].restoredSession, false);
  assert.equal(h.timers.size, 0);
});
