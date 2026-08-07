/**
 * Reading and sending on the linked account's full inbox - the data layer for
 * the panel's Messages tab.
 *
 * Chat listing follows the same lesson learned in groups.js: the official
 * `client.getChats()` builds a full model for every chat in one Promise.all,
 * and for a group that includes `groupMetadata.update()` - a network round
 * trip - so one unhappy chat rejects the entire inbox. We only need id, name,
 * unread count and a last-message preview for the list, none of which need
 * that refresh, so we read the chat collection directly and tolerate
 * individual failures. `client.getChats()` stays as a fallback.
 */

const { MessageMedia } = require('whatsapp-web.js');

const CHAT_SERVERS = new Set(['c.us', 'lid', 'g.us']);

/** Shape shared by every message we hand to the panel, live or historical. */
function mapMessage(m) {
  return {
    id: m.id?._serialized || String(m.id),
    body: m.body || '',
    timestamp: m.timestamp ?? m.t ?? null,
    fromMe: Boolean(m.fromMe ?? m.id?.fromMe),
    author: m.author || null,
    type: m.type,
    hasMedia: Boolean(m.hasMedia ?? m.directPath),
    ack: m.ack,
  };
}

/** The chat a message belongs to - `from` for anything received, `to` for
 * anything we sent (from the panel, the phone, or another linked session). */
function chatIdFor(msg) {
  const fromMe = Boolean(msg.fromMe ?? msg.id?.fromMe);
  const to = typeof msg.to === 'object' ? msg.to?._serialized : msg.to;
  const from = typeof msg.from === 'object' ? msg.from?._serialized : msg.from;
  return fromMe ? to : from;
}

async function listChatsFast(client) {
  return client.pupPage.evaluate(async () => {
    const collections = window.require('WAWebCollections');
    const chats = collections.Chat.getModelsArray();
    const out = [];
    for (const chat of chats) {
      try {
        const server = chat.id?.server;
        if (!['c.us', 'lid', 'g.us'].includes(server)) continue;

        let lastMessage = null;
        try {
          const key = chat.lastReceivedKey;
          const raw = key
            ? collections.Msg.get(key._serialized) ||
              (await collections.Msg.getMessagesById([key._serialized]))?.messages?.[0]
            : null;
          const model = raw && window.WWebJS.getMessageModel(raw);
          if (model) {
            lastMessage = {
              body: model.hasMedia ? model.caption || '' : model.body || '',
              type: model.type,
              fromMe: Boolean(model.id?.fromMe),
              timestamp: model.t || null,
              hasMedia: Boolean(model.directPath),
            };
          }
        } catch {
          // Preview only - the chat itself still belongs in the list.
        }

        out.push({
          id: chat.id._serialized,
          isGroup: server === 'g.us',
          name: chat.formattedTitle || chat.name || '',
          unreadCount: chat.unreadCount || 0,
          timestamp: chat.t || null,
          archived: Boolean(chat.archive),
          pinned: Boolean(chat.pin),
          lastMessage,
        });
      } catch {
        // One malformed chat must not cost us the whole list.
      }
    }
    return out;
  });
}

async function listChatsViaGetChats(client) {
  const chats = await client.getChats();
  return chats
    .filter((chat) => CHAT_SERVERS.has(chat.id?.server))
    .map((chat) => ({
      id: chat.id._serialized,
      isGroup: Boolean(chat.isGroup),
      name: chat.name || '',
      unreadCount: chat.unreadCount || 0,
      timestamp: chat.timestamp || null,
      archived: Boolean(chat.archived),
      pinned: Boolean(chat.pinned),
      lastMessage: chat.lastMessage
        ? {
            body: chat.lastMessage.body || '',
            type: chat.lastMessage.type,
            fromMe: Boolean(chat.lastMessage.fromMe),
            timestamp: chat.lastMessage.timestamp || null,
            hasMedia: Boolean(chat.lastMessage.hasMedia),
          }
        : null,
    }));
}

async function listChats(client) {
  let chats;
  try {
    chats = await listChatsFast(client);
  } catch (err) {
    console.warn(`[wa] fast chat listing failed (${err.message}), falling back to getChats()`);
    chats = await listChatsViaGetChats(client);
  }

  return chats
    .map((chat) => ({
      ...chat,
      name: chat.name || (chat.isGroup ? '(unnamed group)' : chat.id.split('@')[0]),
    }))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/** Message history for one chat, oldest first - ready to render top to bottom. */
async function fetchMessages(client, chatId, { limit = 50 } = {}) {
  const chat = await client.getChatById(chatId);
  if (!chat) return null;
  const msgs = await chat.fetchMessages({ limit });
  return msgs.map(mapMessage);
}

async function sendMessage(client, chatId, text) {
  const msg = await client.sendMessage(chatId, text);
  return mapMessage(msg);
}

async function markRead(client, chatId) {
  await client.sendSeen(chatId);
}

/** Downloads the media attached to one message. Null if there is none, or
 * WhatsApp can't resolve it (expired, still uploading, etc). */
async function downloadMessageMedia(client, messageId) {
  const msg = await client.getMessageById(messageId);
  if (!msg || !msg.hasMedia) return null;
  const media = await msg.downloadMedia();
  if (!media) return null;
  return { mimetype: media.mimetype, data: media.data, filename: media.filename || null };
}

/**
 * Sends a file as media. `asVoice` and `asDocument` map straight onto
 * whatsapp-web.js's own send options - the opus/waveform conversion for a
 * voice note happens inside WhatsApp Web's own page JS, not here.
 */
async function sendMedia(
  client,
  chatId,
  { buffer, mimetype, filename, caption, asVoice = false, asDocument = false } = {}
) {
  const media = new MessageMedia(mimetype, buffer.toString('base64'), filename);
  const msg = await client.sendMessage(chatId, media, {
    caption,
    sendAudioAsVoice: Boolean(asVoice),
    sendMediaAsDocument: Boolean(asDocument),
  });
  return mapMessage(msg);
}

module.exports = {
  mapMessage,
  chatIdFor,
  listChats,
  listChatsFast,
  listChatsViaGetChats,
  fetchMessages,
  sendMessage,
  markRead,
  downloadMessageMedia,
  sendMedia,
};
