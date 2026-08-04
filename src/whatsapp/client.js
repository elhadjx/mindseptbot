const { Client, RemoteAuth, Events } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { MongoSessionStore } = require('./mongo-session-store');

const { config } = require('../config');
const { mongoose } = require('../db/mongo');
const { bus, EVENTS } = require('../events');

// Live connection state, mirrored to the admin panel over SSE.
const state = {
  status: 'starting', // starting | qr | authenticated | ready | disconnected | auth_failure
  qrDataUrl: null,
  me: null, // { pushname, phone }
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
  return state.status === 'ready';
}

/**
 * whatsapp-web.js destroys the Client after emitting `disconnected`, so the old
 * instance can never be re-initialized - we have to build a fresh one. (The
 * previous version called client.initialize() on the destroyed instance, which
 * is why a single blip turned into a permanent "waiting for scan".)
 */
function scheduleReconnect() {
  if (reconnectTimer || stopped) return;
  // 5s, 10s, 20s, 40s ... capped at 5 minutes.
  const delay = Math.min(5000 * 2 ** reconnectAttempt, 300000);
  reconnectAttempt += 1;
  console.log(`[wa] reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await buildAndInitialize();
    } catch (err) {
      console.error('[wa] reconnect failed:', err.message);
      scheduleReconnect();
    }
  }, delay);
}

function buildClient() {
  // dataPath must match what RemoteAuth is given below - the store rebuilds the
  // zip path from it, since RemoteAuth only passes a path to extract().
  const store = new MongoSessionStore({ mongoose, dataPath: config.whatsapp.dataPath });

  return new Client({
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
    const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    setState({ status: 'qr', qrDataUrl, me: null, sessionBackedUp: false, lastError: null });
    console.log('[wa] QR received - scan it from the admin panel (Connection tab)');
  });

  instance.on(Events.AUTHENTICATED, () => {
    setState({ status: 'authenticated', qrDataUrl: null, lastError: null });
    console.log('[wa] authenticated');
  });

  instance.on(Events.AUTHENTICATION_FAILURE, (message) => {
    setState({ status: 'auth_failure', qrDataUrl: null, lastError: String(message) });
    console.error('[wa] auth failure:', message);
  });

  instance.on(Events.READY, () => {
    reconnectAttempt = 0;
    setState({
      status: 'ready',
      qrDataUrl: null,
      lastReadyAt: new Date().toISOString(),
      lastError: null,
      me: instance.info
        ? { pushname: instance.info.pushname, phone: instance.info.wid?.user || null }
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
    setState({ lastSessionSavedAt: new Date().toISOString(), sessionBackedUp: true });
    console.log('[wa] remote session saved');
  });

  instance.on(Events.DISCONNECTED, (reason) => {
    // Anything that reaches here has already had its stored session deleted by
    // RemoteAuth.disconnect(), so the next start will need a fresh QR. Log the
    // reason plainly - it is the only clue as to why.
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
    // Never let a handler error take down the client.
    Promise.resolve(onMessageHandler(msg)).catch((err) =>
      console.error('[wa] message handler error:', err)
    );
  });
}

async function buildAndInitialize() {
  client = buildClient();
  wireEvents(client);
  await client.initialize();
  return client;
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
async function logoutWhatsApp() {
  if (!client) return;
  try {
    await client.logout();
  } catch (err) {
    console.warn('[wa] logout failed, destroying client instead:', err.message);
    await client.destroy().catch(() => {});
  }
  setState({ status: 'disconnected', qrDataUrl: null, me: null, sessionBackedUp: false });
  scheduleReconnect();
}

/** Stop reconnecting - used on shutdown so we don't fight a closing process. */
function stopWhatsApp() {
  stopped = true;
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
