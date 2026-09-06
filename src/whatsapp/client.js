const { RemoteAuth, Events } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { MongoSessionStore } = require('./mongo-session-store');
const { StartupClient } = require('./startup-client');

const { config } = require('../config');
const { mongoose } = require('../db/mongo');
const { bus, EVENTS } = require('../events');
const { mapMessage, chatIdFor } = require('./messages');

// Live connection state, mirrored to the admin panel over SSE.
const state = {
  status: 'starting', // starting | qr | authenticated | ready | disconnected | auth_failure
  qrDataUrl: null,
  me: null, // { pushname, phone, wid }
  lastReadyAt: null,
  lastSessionSavedAt: null,
  // RemoteAuth does not write the session to Mongo until 60s after the first
  // authentication (a hardcoded delay in its afterAuthReady). Until that lands,
  // a restart loses the link and forces a new QR - so the panel warns about it.
  sessionBackedUp: false,
  lastError: null,
};

let client = null;
let onMessageHandler = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let stopped = false;
let initializationPromise = null;
let logoutPromise = null;
const retiredClients = new WeakSet();

function isActiveClient(instance) {
  return Boolean(instance) && !stopped && client === instance && !retiredClients.has(instance);
}

function retireClient(instance) {
  retiredClients.add(instance);
  instance.cancelStartup();
}

async function destroyClient(instance) {
  retireClient(instance);
  // destroy() closes Chromium and stops RemoteAuth backups without unlinking
  // the account. logout()/disconnect() would delete the session from Mongo.
  await instance.destroy();
  // Keep the reference if cleanup fails: the next attempt must finish closing
  // this browser before RemoteAuth extracts into the same profile directory.
  if (client === instance) client = null;
}

function getState() {
  return { ...state };
}

function setState(patch) {
  Object.assign(state, patch);
  bus.emit(EVENTS.WA_STATE, getState());
}

function getClient() {
  return client;
}

/** The client can accept commands only once WhatsApp reports it ready. */
function isReady() {
  return state.status === 'ready' && isActiveClient(client);
}

/**
 * whatsapp-web.js destroys the Client after emitting `disconnected`, so the old
 * instance can never be re-initialized - we have to build a fresh one. (The
 * previous version called client.initialize() on the destroyed instance, which
 * is why a single blip turned into a permanent "waiting for scan".)
 */
function scheduleReconnect() {
  // An in-flight startup owns cleanup and schedules its retry when it settles.
  if (reconnectTimer || stopped || initializationPromise || logoutPromise) return;
  // 5s, 10s, 20s, 40s ... capped at 5 minutes.
  const delay = Math.min(5000 * 2 ** reconnectAttempt, 300000);
  reconnectAttempt += 1;
  console.log(`[wa] reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await buildAndInitialize();
    } catch (err) {
      console.error('[wa] reconnect failed:', err?.message || String(err));
    }
  }, delay);
}

function buildClient() {
  // dataPath must match what RemoteAuth is given below - the store rebuilds the
  // zip path from it, since RemoteAuth only passes a path to extract().
  const store = new MongoSessionStore({ mongoose, dataPath: config.whatsapp.dataPath });

  return new StartupClient({
    authStrategy: new RemoteAuth({
      store,
      clientId: config.whatsapp.clientId,
      backupSyncIntervalMs: config.whatsapp.backupSyncIntervalMs,
      dataPath: config.whatsapp.dataPath,
    }),
    // Without this, WhatsApp reporting CONFLICT (another WhatsApp Web session
    // opened - a second container, an overlapping deploy, or someone opening
    // web.whatsapp.com) is treated as a fatal disconnect, and RemoteAuth's
    // disconnect() DELETES the stored session. Taking the session over instead
    // keeps the link alive and the session in Mongo.
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    puppeteer: {
      executablePath: config.whatsapp.puppeteerExecutablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Containers give /dev/shm only 64MB by default, which crashes Chromium.
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });
}

function wireEvents(instance) {
  instance.on(Events.QR_RECEIVED, async (qr) => {
    if (!isActiveClient(instance)) return;
    const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    if (!isActiveClient(instance)) return;
    setState({ status: 'qr', qrDataUrl, me: null, sessionBackedUp: false, lastError: null });
    console.log('[wa] QR received - scan it from the admin panel (Connection tab)');
  });

  instance.on(Events.AUTHENTICATED, () => {
    if (!isActiveClient(instance)) return;
    setState({ status: 'authenticated', qrDataUrl: null, lastError: null });
    console.log('[wa] authenticated');
  });

  instance.on(Events.AUTHENTICATION_FAILURE, (message) => {
    if (!isActiveClient(instance)) return;
    setState({ status: 'auth_failure', qrDataUrl: null, lastError: String(message) });
    console.error('[wa] auth failure:', message);
  });

  instance.on(Events.READY, () => {
    if (!isActiveClient(instance)) return;
    reconnectAttempt = 0;
    setState({
      status: 'ready',
      qrDataUrl: null,
      lastReadyAt: new Date().toISOString(),
      lastError: null,
      // `wid` is the linked account's own JID - the panel asks the avatar
      // endpoint for it to show the account's picture where the QR used to be.
      me: instance.info
        ? {
            pushname: instance.info.pushname,
            phone: instance.info.wid?.user || null,
            wid: instance.info.wid?._serialized || null,
          }
        : null,
    });
    console.log('[wa] ready');
    if (!state.sessionBackedUp) {
      console.log(
        '[wa] session is NOT backed up to Mongo yet - RemoteAuth waits 60s after ' +
          'first auth. Do not redeploy until you see "remote session saved".'
      );
    }
  });

  instance.on(Events.REMOTE_SESSION_SAVED, () => {
    if (!isActiveClient(instance)) return;
    setState({ lastSessionSavedAt: new Date().toISOString(), sessionBackedUp: true });
    console.log('[wa] remote session saved');
  });

  instance.on(Events.DISCONNECTED, (reason) => {
    if (!isActiveClient(instance)) return;
    retireClient(instance);
    // The library clears RemoteAuth on a real disconnect (for LOGOUT, just
    // after emitting this event). Startup exceptions are handled separately.
    const isLogout = String(reason) === 'LOGOUT';
    setState({
      status: 'disconnected',
      qrDataUrl: null,
      me: null,
      sessionBackedUp: false,
      lastError: isLogout
        ? 'Logged out from the phone. Scan again to re-link.'
        : `Disconnected (${reason}). The stored session was cleared; a new QR will follow.`,
    });
    console.warn(`[wa] disconnected: ${reason}`);
    scheduleReconnect();
  });

  instance.on(Events.MESSAGE_RECEIVED, (msg) => {
    if (!isActiveClient(instance)) return;
    // The Messages tab wants every message live, independent of whether it
    // turns out to be a door command - never let that emit block or fail the
    // command pipeline below.
    try {
      bus.emit(EVENTS.WA_MESSAGE, { chatId: chatIdFor(msg), message: mapMessage(msg) });
    } catch (err) {
      console.error('[wa] message bus emit failed:', err);
    }
    // Never let a handler error take down the client.
    Promise.resolve(onMessageHandler(msg)).catch((err) =>
      console.error('[wa] message handler error:', err)
    );
  });

  // MESSAGE_RECEIVED only fires for messages that arrived, not ones we sent -
  // so a message sent from the phone itself (or another linked session) needs
  // this separate event to reach the panel live.
  instance.on(Events.MESSAGE_CREATE, (msg) => {
    if (!isActiveClient(instance)) return;
    if (!msg.fromMe) return;
    try {
      bus.emit(EVENTS.WA_MESSAGE, { chatId: chatIdFor(msg), message: mapMessage(msg) });
    } catch (err) {
      console.error('[wa] message bus emit failed:', err);
    }
  });
}

async function initializeClient() {
  try {
    if (client) await destroyClient(client);
    if (stopped) return null;

    setState({ status: 'starting', qrDataUrl: null, me: null });
    const instance = buildClient();
    client = instance;
    wireEvents(instance);
    await instance.initialize();

    // A disconnect or shutdown can arrive while initialize() is awaiting the
    // browser. Retire it even if initialize() subsequently resolves normally.
    if (!isActiveClient(instance)) {
      // Explicit logout owns its cleanup until it has finished unlinking.
      if (!logoutPromise) await destroyClient(instance);
      return null;
    }
    return instance;
  } catch (err) {
    if (!stopped && !logoutPromise) {
      setState({
        status: 'disconnected',
        qrDataUrl: null,
        me: null,
        lastError: err?.message || String(err),
      });
    }
    if (client && !retiredClients.has(client)) {
      await destroyClient(client).catch((cleanupError) => {
        console.warn('[wa] client cleanup failed:', cleanupError?.message || String(cleanupError));
      });
    }
    throw err;
  }
}

function buildAndInitialize() {
  if (stopped) return Promise.resolve(null);
  if (initializationPromise) return initializationPromise;
  if (logoutPromise) return logoutPromise.then(() => buildAndInitialize());
  if (client && !retiredClients.has(client)) return Promise.resolve(client);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;

  initializationPromise = initializeClient().finally(() => {
    initializationPromise = null;
    // Covers initial startup errors as well as later reconnect failures.
    if (!client || retiredClients.has(client)) scheduleReconnect();
  });
  return initializationPromise;
}

/**
 * Build and start the WhatsApp client.
 *
 * RemoteAuth keeps the authenticated session in MongoDB (GridFS, via our own
 * MongoSessionStore) rather than on disk, which is what lets this survive
 * Railway's ephemeral filesystem: `dataPath` is only scratch space RemoteAuth
 * zips from.
 *
 * @param {(msg: import('whatsapp-web.js').Message) => Promise<void>} onMessage
 */
async function startWhatsApp(onMessage) {
  onMessageHandler = onMessage;
  stopped = false;
  return buildAndInitialize();
}

/**
 * Unlink the WhatsApp account and wipe the remote session, forcing a fresh QR.
 */
function logoutWhatsApp() {
  if (logoutPromise) return logoutPromise;
  const instance = client;
  if (!instance || retiredClients.has(instance)) return Promise.resolve();
  retireClient(instance);
  logoutPromise = (async () => {
    try {
      await instance.logout();
    } catch (err) {
      console.warn('[wa] logout failed, destroying client instead:', err?.message || String(err));
    }
    await destroyClient(instance).catch((err) => {
      console.warn('[wa] client cleanup failed:', err?.message || String(err));
    });
    if (!stopped) {
      setState({ status: 'disconnected', qrDataUrl: null, me: null, sessionBackedUp: false });
    }
  })().finally(() => {
    logoutPromise = null;
    scheduleReconnect();
  });
  return logoutPromise;
}

/** Stop reconnecting - used on shutdown so we don't fight a closing process. */
function stopWhatsApp() {
  stopped = true;
  client?.cancelStartup();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

module.exports = {
  startWhatsApp,
  logoutWhatsApp,
  stopWhatsApp,
  getClient,
  getState,
  isReady,
};
