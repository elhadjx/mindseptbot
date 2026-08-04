const { Client, RemoteAuth, Events } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const QRCode = require('qrcode');

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
  lastError: null,
};

let client = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

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

function scheduleReconnect() {
  if (reconnectTimer) return;
  // 5s, 10s, 20s, 40s ... capped at 5 minutes.
  const delay = Math.min(5000 * 2 ** reconnectAttempt, 300000);
  reconnectAttempt += 1;
  console.log(`[wa] reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await client.initialize();
    } catch (err) {
      console.error('[wa] reconnect failed:', err.message);
      scheduleReconnect();
    }
  }, delay);
}

/**
 * Build and start the WhatsApp client.
 *
 * RemoteAuth keeps the authenticated session in MongoDB (GridFS via
 * wwebjs-mongo) rather than on disk, which is what lets this survive Railway's
 * ephemeral filesystem: `dataPath` is just scratch space RemoteAuth zips from.
 *
 * @param {(msg: import('whatsapp-web.js').Message) => Promise<void>} onMessage
 */
async function startWhatsApp(onMessage) {
  const store = new MongoStore({ mongoose });

  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId: config.whatsapp.clientId,
      backupSyncIntervalMs: config.whatsapp.backupSyncIntervalMs,
      dataPath: config.whatsapp.dataPath,
    }),
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

  client.on(Events.QR_RECEIVED, async (qr) => {
    const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    setState({ status: 'qr', qrDataUrl, lastError: null });
    console.log('[wa] QR received - scan it from the admin panel (Connection tab)');
  });

  client.on(Events.AUTHENTICATED, () => {
    setState({ status: 'authenticated', qrDataUrl: null, lastError: null });
    console.log('[wa] authenticated');
  });

  client.on(Events.AUTHENTICATION_FAILURE, (message) => {
    setState({ status: 'auth_failure', qrDataUrl: null, lastError: String(message) });
    console.error('[wa] auth failure:', message);
  });

  client.on(Events.READY, () => {
    reconnectAttempt = 0;
    setState({
      status: 'ready',
      qrDataUrl: null,
      lastReadyAt: new Date().toISOString(),
      lastError: null,
      me: client.info
        ? { pushname: client.info.pushname, phone: client.info.wid?.user || null }
        : null,
    });
    console.log('[wa] ready');
  });

  client.on(Events.REMOTE_SESSION_SAVED, () => {
    setState({ lastSessionSavedAt: new Date().toISOString() });
    console.log('[wa] remote session saved');
  });

  client.on(Events.DISCONNECTED, (reason) => {
    setState({ status: 'disconnected', qrDataUrl: null, lastError: String(reason) });
    console.warn('[wa] disconnected:', reason);
    scheduleReconnect();
  });

  client.on(Events.MESSAGE_RECEIVED, (msg) => {
    // Never let a handler error take down the client.
    Promise.resolve(onMessage(msg)).catch((err) =>
      console.error('[wa] message handler error:', err)
    );
  });

  await client.initialize();
  return client;
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
    await client.destroy();
  }
  setState({ status: 'disconnected', qrDataUrl: null, me: null });
  scheduleReconnect();
}

module.exports = { startWhatsApp, logoutWhatsApp, getClient, getState, isReady };
