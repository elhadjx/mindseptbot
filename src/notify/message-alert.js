/**
 * Phone notifications for incoming WhatsApp messages.
 *
 * The panel already hears every message on the bus - that is what feeds the
 * Messages tab's live stream - so this listens to the same event rather than
 * touching the WhatsApp client or the door-command pipeline.
 *
 * Most of the work here is deciding what NOT to send. A push that fires for
 * our own outgoing mail, for a status update, or five times while someone
 * types five short lines is a push the admin turns off within the day.
 */

const { bus, EVENTS } = require('../events');
const Settings = require('../db/models/Settings');
const { sendPush } = require('./push');
const { getClient, isReady } = require('../whatsapp/client');
const { getChatTitle } = require('../whatsapp/messages');

// Real conversations. Anything else WhatsApp delivers - status@broadcast,
// broadcast lists, channels - is not something the panel can even open.
const CHAT_SERVERS = new Set(['c.us', 'lid', 'g.us']);

const MEDIA_LABELS = {
  image: '📷 Photo',
  video: '🎬 Vidéo',
  audio: '🎵 Audio',
  ptt: '🎤 Message vocal',
  document: '📎 Document',
  sticker: '🩹 Sticker',
};

// A lock screen shows two lines at best; the rest is only weight in the push.
const MAX_BODY = 180;

/** One line describing a message: its text, or what kind of file it is. */
function previewOf(message) {
  const text = String(message.body || '').trim();
  if (text) return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
  if (message.hasMedia) return MEDIA_LABELS[message.type] || '📎 Pièce jointe';
  return 'Nouveau message';
}

function serverOf(chatId) {
  return String(chatId || '').split('@')[1] || '';
}

/** Last-resort name for a chat: the number in its JID. */
function numberOf(chatId) {
  return String(chatId || '').split('@')[0] || 'Inconnu';
}

/**
 * The notifier, with every dependency injected so the filtering rules can be
 * tested without Mongo, a linked session or a real clock.
 *
 * @param {object} deps
 * @param {Function} deps.sendPush      (payload, options) => Promise<number>
 * @param {Function} deps.loadSettings  () => Promise<{ messageAlerts: boolean }>
 * @param {Function} deps.chatTitle     (chatId) => Promise<string|null>
 * @param {number}   [deps.maxAgeSec]   older than this is a reconnect replay
 * @param {number}   [deps.windowMs]    burst-coalescing window
 * @param {Function} [deps.schedule]    setTimeout, injectable for tests
 * @param {Function} [deps.now]         Date.now, injectable for tests
 */
function createMessageNotifier({
  sendPush: push,
  loadSettings,
  chatTitle,
  maxAgeSec = 60,
  windowMs = 5000,
  schedule = setTimeout,
  now = Date.now,
}) {
  // chatId -> { count, message, timer }. One entry per chat mid-burst.
  const pending = new Map();

  /**
   * Send what a chat has accumulated.
   *
   * The push carries the LATEST message rather than the one that opened the
   * window: a notification arriving after the burst has ended should say what
   * the conversation last said, not what it said five seconds ago.
   */
  async function flush(chatId) {
    const batch = pending.get(chatId);
    if (!batch) return;
    pending.delete(chatId);

    const { message, count } = batch;
    const isGroup = serverOf(chatId) === 'g.us';
    const sender = message.notifyName || numberOf(message.author || chatId);
    const title = (await chatTitle(chatId)) || (isGroup ? 'Groupe' : sender);

    // In a group the chat name is the title, so the sender has to be in the
    // body or there is no way to tell who spoke.
    let body = isGroup ? `${sender}: ${previewOf(message)}` : previewOf(message);
    if (count > 1) body = `${count} nouveaux messages · ${body}`;

    await push(
      {
        title,
        body,
        // One line per chat in the shade: a later message from the same
        // conversation replaces its predecessor instead of stacking.
        tag: `chat:${chatId}`,
        url: `/#messages/${encodeURIComponent(chatId)}`,
        // Unlike a door outage, a message is not something the admin has to
        // acknowledge before it will leave the screen.
        requireInteraction: false,
      },
      // A chat message that shows up an hour late is noise, and it is not
      // worth waking a dozing phone for.
      { ttl: 600, urgency: 'normal' }
    );
  }

  async function handle({ chatId, message } = {}) {
    if (!chatId || !message) return;
    // Our own outgoing mail reaches the bus too (MESSAGE_CREATE), so the panel
    // can show what was sent from the phone.
    if (message.fromMe) return;
    if (!CHAT_SERVERS.has(serverOf(chatId))) return;

    // On reconnect whatsapp-web.js replays a backlog. Without this guard every
    // restart empties yesterday's inbox onto the lock screen.
    const ageSec = now() / 1000 - Number(message.timestamp || 0);
    if (Number.isFinite(ageSec) && ageSec > maxAgeSec) return;

    const settings = await loadSettings();
    if (!settings?.messageAlerts) return;

    const batch = pending.get(chatId);
    if (batch) {
      // Mid-burst: keep the newest message and let the running timer fire.
      batch.count += 1;
      batch.message = message;
      return;
    }

    pending.set(chatId, {
      count: 1,
      message,
      timer: schedule(() => {
        flush(chatId).catch((err) =>
          console.error('[alert] message notification failed:', err.message)
        );
      }, windowMs),
    });
  }

  /** Drop anything still waiting - used on shutdown, and by the tests. */
  function reset() {
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
  }

  return { handle, flush, reset, pendingCount: () => pending.size };
}

/**
 * Chat titles change rarely and cost a round trip into the WhatsApp page, so
 * one lookup covers a conversation for ten minutes.
 */
function createTitleResolver({ ttlMs = 10 * 60 * 1000 } = {}) {
  const cache = new Map(); // chatId -> { at, title }

  return async function titleOf(chatId) {
    const hit = cache.get(chatId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.title;
    // Asking a client that isn't linked yet would throw for every message of
    // the reconnect burst; the sender's own pushname covers us until it is.
    if (!isReady()) return null;

    const title = await getChatTitle(getClient(), chatId);
    cache.set(chatId, { at: Date.now(), title });
    return title;
  };
}

/** Wire the notifier to the live bus. Call once at startup. */
function startMessageAlerts() {
  const notifier = createMessageNotifier({
    sendPush,
    loadSettings: () => Settings.load(),
    chatTitle: createTitleResolver(),
  });

  bus.on(EVENTS.WA_MESSAGE, (event) => {
    // A notification is never worth taking the message stream down for.
    Promise.resolve(notifier.handle(event)).catch((err) =>
      console.error('[alert] message notification failed:', err.message)
    );
  });

  return notifier;
}

module.exports = { createMessageNotifier, createTitleResolver, startMessageAlerts, previewOf };
