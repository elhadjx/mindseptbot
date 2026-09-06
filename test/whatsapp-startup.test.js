const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { compileFunction, createContext, runInContext } = require('node:vm');
const { Events } = require('whatsapp-web.js');

const startupPath = path.resolve(__dirname, '../src/whatsapp/startup-client.js');
const upstreamPath = require.resolve('whatsapp-web.js/src/Client.js');
const contextError = () => new Error(
  'Protocol error (Runtime.callFunctionOn): Execution context was destroyed.'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadModule(filename, replacements, extraGlobals = {}) {
  const module = { exports: {} };
  const realRequire = createRequire(filename);
  compileFunction(
    fs.readFileSync(filename, 'utf8'),
    ['require', 'module', ...Object.keys(extraGlobals)],
    { filename }
  )(
    (name) => replacements[name] || realRequire(name), module, ...Object.values(extraGlobals)
  );
  return module.exports;
}

function wrap(Client) {
  return loadModule(startupPath, { 'whatsapp-web.js': { Client } }, {
    console: { warn() {} },
  }).StartupClient;
}

/**
 * Runs the installed library's initialize() and inject() against separate VM
 * documents. Navigation destroys in-flight evaluate() calls, including the
 * actual asynchronous socket-state wait that failed at Client.js:146.
 * Browser transport and WhatsApp modules are fixtures; no live account is used.
 */
function integration({ wrapped = true } = {}) {
  const authWaiting = deferred();
  const calls = { launches: 0, restores: 0, closes: 0, deletes: 0, ready: 0, attach: 0 };
  const bindings = new Map();
  const bindingCalls = [];
  const page = new EventEmitter();
  page.closed = false;
  page.waits = 0;
  page.disposals = 0;
  page.gotos = 0;
  page.isClosed = () => page.closed;
  page.goto = async () => { page.gotos += 1; };
  page.exposeFunction = async (name, fn) => {
    assert.equal(bindings.has(name), false, `duplicate exposed function: ${name}`);
    const binding = (...args) => {
      const pending = Promise.resolve().then(() => fn(...args));
      bindingCalls.push(pending);
      return pending;
    };
    bindings.set(name, binding);
    page.document.window[name] = binding;
  };
  page.evaluate = async (fn, ...args) => {
    const document = page.document;
    document.context.args = args;
    const expression = typeof fn === 'string' ? fn : `(${fn.toString()})(...args)`;
    return Promise.race([runInContext(expression, document.context), document.destroyed.promise]);
  };
  page.waitForFunction = async (fn, options) => {
    page.waits += 1;
    assert.equal(options.timeout, 30000);
    assert.ok(options.polling > 0);
    options.signal.throwIfAborted();
    assert.equal(await page.evaluate(fn), true, 'new document must be booted before retrying');
    return { dispose: async () => { page.disposals += 1; } };
  };
  page.newDocument = (state) => {
    page.document?.destroyed.reject(contextError());
    const socket = new EventEmitter();
    socket.state = state;
    socket.on('newListener', (event) => {
      if (event === 'change:state' && socket.state === 'OPENING') authWaiting.resolve();
    });
    const conn = new EventEmitter();
    conn.ref = 'fixture-qr';
    conn.serialize = () => ({ pushname: 'Fixture' });
    const modules = {
      WAWebSocketModel: { Socket: socket },
      WAWebCmd: { Cmd: new EventEmitter() },
      WAWebConnModel: { Conn: conn },
      WAWebOfflineHandler: { OfflineMessageHandler: {} },
      WAWebAltDeviceLinkingApi: {},
      WABase64: { encodeB64: () => 'fixture-key' },
      WAWebCompanionRegClientUtils: {
        waSignalStore: { getRegistrationInfo: async () => ({ identityKeyPair: { pubKey: [] } }) },
        waNoiseInfo: { get: async () => ({ staticKeyPair: { pubKey: [] } }) },
        DEVICE_PLATFORM: 'fixture',
      },
      WAWebAdvSignatureApi: {},
      WAWebUserPrefsInfoStore: {},
      WAWebSignalStoreApi: {},
      WAWebUserPrefsMultiDevice: { getADVSecretKey: () => 'fixture-secret' },
      WAWebUserPrefsMeUser: { getMaybeMePnUser: () => ({ user: '123', _serialized: '123@c.us' }) },
    };
    const window = {
      Debug: { VERSION: 'fixture-version' },
      require: (name) => {
        assert.ok(Object.hasOwn(modules, name), `Unexpected WhatsApp module: ${name}`);
        return modules[name];
      },
      ...Object.fromEntries(bindings),
    };
    const destroyed = deferred();
    // A document can be destroyed while no evaluation is in flight.
    destroyed.promise.catch(() => {});
    page.document = { window, socket, destroyed, context: createContext({ window }) };
  };
  page.newDocument('OPENING');
  const browser = {
    isConnected: () => !page.closed,
    pages: async () => [page],
    close: async () => {
      calls.closes += 1;
      page.closed = true;
      page.document.destroyed.reject(new Error('Target closed'));
    },
  };
  const UpstreamClient = loadModule(upstreamPath, {
    puppeteer: { launch: async () => { calls.launches += 1; return browser; } },
    // Large messaging helpers are outside this regression. The upstream
    // authentication, callback registration, ClientInfo, and ready flow run.
    './util/Injected/Utils': { LoadUtils: () => { window.WWebJS = {}; } },
  });
  const ClientClass = wrapped ? wrap(UpstreamClient) : UpstreamClient;
  const client = new ClientClass({
    userAgent: false,
    authStrategy: {
      setup() {},
      async beforeBrowserInitialized() { calls.restores += 1; },
      async afterBrowserInitialized() {},
      async onAuthenticationNeeded() { return { failed: false }; },
      async getAuthEventPayload() {},
      afterAuthReady() { calls.ready += 1; },
      async destroy() {},
      async logout() { calls.deletes += 1; },
    },
  });
  client.initWebVersionCache = async () => {};
  client.attachEventListeners = async () => { calls.attach += 1; };
  return {
    client, page, calls, authWaiting: authWaiting.promise,
    async sync() {
      page.document.socket.emit('change:hasSynced');
      await Promise.all(bindingCalls);
    },
  };
}

test('unmodified upstream startup fails when navigation interrupts the authentication wait', async () => {
  const h = integration({ wrapped: false });
  const starting = assert.rejects(h.client.initialize(), /Execution context was destroyed/);
  await h.authWaiting;
  h.page.newDocument('CONNECTED');
  await starting;
  assert.equal(h.page.listenerCount('framenavigated'), 0);
  assert.equal(h.page.waits, 0);
  await h.client.destroy();
});

test('startup recovers in the same browser and reaches ready using upstream injection', async () => {
  const h = integration();
  let authenticated = 0;
  let ready = 0;
  h.client.on(Events.AUTHENTICATED, () => { authenticated += 1; });
  h.client.on(Events.READY, () => { ready += 1; });
  const starting = h.client.initialize();
  await h.authWaiting;
  const concurrent = h.client.inject();
  assert.equal(concurrent, h.client.inject(), 'concurrent injection must share one attempt');
  h.page.newDocument('CONNECTED');
  await Promise.all([starting, concurrent]);
  await h.sync();
  assert.equal(authenticated, 1);
  assert.equal(ready, 1);
  assert.equal(h.client.info.wid._serialized, '123@c.us');
  assert.equal(h.calls.ready, 1);
  assert.equal(h.calls.attach, 1);
  assert.equal(h.page.document.socket.listenerCount('change:hasSynced'), 1);
  assert.equal(h.page.listenerCount('framenavigated'), 1);
  assert.equal(h.page.waits, 1);
  assert.equal(h.page.disposals, 1);
  assert.equal(h.page.gotos, 1);
  assert.equal(h.calls.launches, 1);
  assert.equal(h.calls.restores, 1);
  assert.equal(h.calls.closes, 0);
  assert.equal(h.calls.deletes, 0);
  await h.client.destroy();
});

test('recovery can also reach the upstream QR flow when the new document needs pairing', async () => {
  const h = integration();
  const codes = [];
  h.client.on(Events.QR_RECEIVED, (code) => codes.push(code));
  const starting = h.client.initialize();
  await h.authWaiting;
  h.page.newDocument('UNPAIRED');
  await starting;
  assert.equal(codes.length, 1);
  assert.match(codes[0], /^fixture-qr,/);
  assert.equal(h.calls.launches, 1);
  assert.equal(h.calls.deletes, 0);
  await h.client.destroy();
});

function unit({ inject = async () => {}, wait } = {}) {
  const calls = { inject: 0, wait: 0, destroy: 0, dispose: 0 };
  let closed = false;
  class BaseClient {
    constructor() {
      this.pupBrowser = { isConnected: () => !closed };
      this.pupPage = {
        isClosed: () => closed,
        waitForFunction: async (predicate, options) => {
          calls.wait += 1;
          if (wait) return wait(predicate, options);
          return { dispose: async () => { calls.dispose += 1; } };
        },
      };
    }
    async initialize() { return this.inject(); }
    async inject() { calls.inject += 1; return inject(this, calls.inject); }
    async destroy() { calls.destroy += 1; closed = true; }
  }
  const StartupClient = wrap(BaseClient);
  return { client: new StartupClient(), calls, closeTransport: () => { closed = true; } };
}

test('repeated navigation is limited to three injections before the outer reconnect takes over', async () => {
  const error = contextError();
  const h = unit({ inject: async () => { throw error; } });
  await assert.rejects(h.client.initialize(), (err) => err === error);
  assert.equal(h.calls.inject, 3);
  assert.equal(h.calls.wait, 2);
  assert.equal(h.calls.dispose, 2);
  assert.equal(h.calls.destroy, 0, 'the outer lifecycle owns browser replacement');
});

test('missing execution contexts recover, while unrelated failures propagate immediately', async () => {
  const h = unit({ inject: async (_client, attempt) => {
    if (attempt === 1) throw new Error('Protocol error: Cannot find context with specified id');
  } });
  await h.client.initialize();
  assert.equal(h.calls.inject, 2);
  for (const error of [new Error('Target closed'), new Error('WA module changed'), 'auth timeout']) {
    const failure = unit({ inject: async () => { throw error; } });
    await assert.rejects(failure.client.initialize(), (err) => err === error);
    assert.equal(failure.calls.inject, 1);
    assert.equal(failure.calls.wait, 0);
  }
});

test('a closed browser is handed back to the outer reconnect without injection retries', async () => {
  const error = contextError();
  const h = unit({ inject: async () => {
    h.closeTransport();
    throw error;
  } });
  await assert.rejects(h.client.initialize(), (err) => err === error);
  assert.equal(h.calls.inject, 1);
  assert.equal(h.calls.wait, 0);
});

test('a context wait timeout propagates and does not restart injection prematurely', async () => {
  const timeout = new Error('Waiting failed: 30000ms exceeded');
  const h = unit({
    inject: async () => { throw contextError(); },
    wait: async (_predicate, options) => {
      assert.equal(options.timeout, 30000);
      throw timeout;
    },
  });
  await assert.rejects(h.client.initialize(), (error) => error === timeout);
  assert.equal(h.calls.inject, 1);
  assert.equal(h.calls.wait, 1);
});

for (const action of ['cancelStartup', 'destroy']) {
  test(`${action} cancels the document wait and prevents another injection`, async () => {
    const waiting = deferred();
    const h = unit({
      inject: async () => { throw contextError(); },
      wait: async (_predicate, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        waiting.resolve();
      }),
    });
    const starting = assert.rejects(h.client.initialize(), /startup cancelled/);
    await waiting.promise;
    await h.client[action]();
    await starting;
    assert.equal(h.calls.inject, 1);
    assert.equal(h.calls.wait, 1);
    assert.equal(h.calls.destroy, action === 'destroy' ? 1 : 0);
  });
}

test('normal startup adds no waits and later injections retain upstream behavior', async () => {
  const error = contextError();
  const h = unit({ inject: async (_client, attempt) => { if (attempt > 1) throw error; } });
  await h.client.initialize();
  assert.equal(h.calls.wait, 0);
  await assert.rejects(h.client.inject(), (err) => err === error);
  assert.equal(h.calls.inject, 2);
  assert.equal(h.calls.wait, 0);
});
