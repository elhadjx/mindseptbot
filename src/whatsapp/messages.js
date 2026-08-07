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

// WhatsApp only ever assigns these types to a message carrying an attachment,
// which makes the type a more dependable "is this media" signal than any one
// field: a live Message exposes `hasMedia`, a serialized model exposes
// `directPath`, and which of those is populated depends on where the message
// came from. Getting this wrong renders a photo as an empty text bubble.
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);

/** Shape shared by every message we hand to the panel, live or historical. */
function mapMessage(m) {
  const hasMedia =
    MEDIA_TYPES.has(m.type) ||
    Boolean(typeof m.hasMedia === 'boolean' ? m.hasMedia : m.directPath);

  return {
    id: m.id?._serialized || String(m.id),
    // A live Message has already folded the caption into `body`; a serialized
    // model keeps the two apart and leaves `body` empty on media.
    body: (hasMedia ? m.body || m.caption : m.body) || '',
    timestamp: m.timestamp ?? m.t ?? null,
    fromMe: Boolean(m.fromMe ?? m.id?.fromMe),
    author: typeof m.author === 'object' ? m.author?._serialized || null : m.author || null,
    type: m.type,
    hasMedia,
    // Lets the panel label a document with its real filename rather than the
    // caption, and pick a player before the bytes are fetched.
    filename: m.filename || null,
    mimetype: m.mimetype || null,
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

/**
 * `client.getChatById()` builds the SAME full chat model as `getChats()` -
 * `getChatModel()` under the hood - which is the network-call-per-group
 * failure mode documented at the top of this file. `Chat.prototype
 * .fetchMessages()` itself is safe (it asks for `getAsModel: false`), but
 * reaching it required calling the unsafe `getChatById()` first. This mirrors
 * whatsapp-web.js's own fetchMessages implementation, driven by a raw chatId
 * instead of a pre-built Chat instance, so the unsafe call is never made.
 */
async function fetchMessagesFast(client, chatId, { limit = 50 } = {}) {
  return client.pupPage.evaluate(
    async (id, max) => {
      const chat = await window.WWebJS.getChat(id, { getAsModel: false });
      if (!chat) return null;

      const msgFilter = (m) => !m.isNotification;
      let msgs = chat.msgs.getModelsArray().filter(msgFilter);

      if (max > 0) {
        while (msgs.length < max) {
          const loaded = await window
            .require('WAWebChatLoadMessages')
            .loadEarlierMsgs({ chat });
          if (!loaded || !loaded.length) break;
          msgs = [...loaded.filter(msgFilter), ...msgs];
        }
        if (msgs.length > max) {
          msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
          msgs = msgs.splice(msgs.length - max);
        }
      }

      return msgs.map((m) => window.WWebJS.getMessageModel(m));
    },
    chatId,
    limit
  );
}

async function fetchMessagesViaChat(client, chatId, { limit = 50 } = {}) {
  const chat = await client.getChatById(chatId);
  if (!chat) return null;
  return chat.fetchMessages({ limit });
}

/** Message history for one chat, oldest first - ready to render top to bottom. */
async function fetchMessages(client, chatId, { limit = 50 } = {}) {
  let msgs;
  try {
    msgs = await fetchMessagesFast(client, chatId, { limit });
  } catch (err) {
    console.warn(`[wa] fast message fetch failed (${err.message}), falling back to getChatById()`);
    msgs = await fetchMessagesViaChat(client, chatId, { limit });
  }
  return msgs ? msgs.map(mapMessage) : null;
}

/**
 * whatsapp-web.js hands the message to the chat and THEN looks the sent model
 * back up by its new key (`Msg.get(newMsgKey._serialized)`). Under LID
 * addressing that lookup can miss, and `client.sendMessage()` returns
 * undefined even though the message has already gone out - which is what
 * produced "Cannot read properties of undefined (reading 'id')".
 *
 * Returning null there is no good either: the panel has nothing to render, so
 * a message that was genuinely sent stays invisible until a reload. Read the
 * chat's newest message back instead - it is the one we just added to it.
 */
async function readBackSentMessage(client, chatId) {
  try {
    const recent = await fetchMessages(client, chatId, { limit: 1 });
    const newest = recent?.[recent.length - 1];
    // Only ours: if something arrived in the intervening moment, we would
    // rather show nothing than attribute someone else's message to us.
    return newest?.fromMe ? newest : null;
  } catch (err) {
    console.warn(`[wa] could not read back the sent message: ${err.message}`);
    return null;
  }
}

async function sendMessage(client, chatId, text) {
  const msg = await client.sendMessage(chatId, text);
  return msg ? mapMessage(msg) : readBackSentMessage(client, chatId);
}

async function markRead(client, chatId) {
  await client.sendSeen(chatId);
}

/**
 * Downloads the media attached to one message.
 *
 * This mirrors Message.downloadMedia(), but keyed straight off the Msg
 * collection rather than reached through `client.getMessageById()`. That
 * getter re-parses the serialized id and throws "Invalid serialized message
 * id specified" for anything that isn't exactly 3 or 4 underscore-separated
 * parts, and rebuilds the whole message model just to read four media fields
 * off it - neither of which we need to download bytes.
 *
 * Returns null when there is no media, or WhatsApp cannot resolve it
 * (expired, still uploading, download errored).
 */
async function downloadMessageMediaFast(client, messageId) {
  return client.pupPage.evaluate(async (msgId) => {
    const collections = window.require('WAWebCollections');
    const msg =
      collections.Msg.get(msgId) ||
      (await collections.Msg.getMessagesById([msgId]))?.messages?.[0];

    // REUPLOADING means the media expired and the phone is re-uploading it.
    if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return null;

    if (msg.mediaData.mediaStage !== 'RESOLVED') {
      await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
    }
    if (msg.mediaData.mediaStage.includes('ERROR') || msg.mediaData.mediaStage === 'FETCHING') {
      return null;
    }

    // The download manager wants a performance-logging handle; it only ever
    // gets chained calls, so a pair of no-ops satisfies it.
    const mockQpl = {
      addAnnotations() {
        return this;
      },
      addPoint() {
        return this;
      },
    };

    const decrypted = await window
      .require('WAWebDownloadManager')
      .downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        signal: new AbortController().signal,
        downloadQpl: mockQpl,
      });

    return {
      data: await window.WWebJS.arrayBufferToBase64Async(decrypted),
      mimetype: msg.mimetype,
      filename: msg.filename,
    };
  }, messageId);
}

async function downloadMessageMediaViaMessage(client, messageId) {
  const msg = await client.getMessageById(messageId);
  if (!msg || !msg.hasMedia) return null;
  const media = await msg.downloadMedia();
  if (!media) return null;
  return { mimetype: media.mimetype, data: media.data, filename: media.filename || null };
}

async function downloadMessageMedia(client, messageId) {
  let media;
  try {
    media = await downloadMessageMediaFast(client, messageId);
  } catch (err) {
    console.warn(`[wa] fast media download failed (${err.message}), falling back to the message`);
    media = await downloadMessageMediaViaMessage(client, messageId);
  }
  if (!media?.data) return null;
  return {
    mimetype: media.mimetype || null,
    data: media.data,
    filename: media.filename || null,
  };
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
  // Same post-send lookup caveat as sendMessage() above. This matters more
  // for media: without a real message id the panel has no URL to fetch the
  // photo or voice note back from, so the bubble would never render.
  return msg ? mapMessage(msg) : readBackSentMessage(client, chatId);
}

/**
 * Profile picture for a chat, as a URL on WhatsApp's own CDN.
 *
 * `client.getProfilePicUrl()` resolves the chat with getAsModel left on,
 * which is the network-bound full model build this file avoids everywhere
 * else - so ask for the raw chat instead.
 */
async function getAvatarUrlFast(client, chatId) {
  return client.pupPage.evaluate(async (id) => {
    try {
      const chat = await window.WWebJS.getChat(id, { getAsModel: false });
      if (!chat) return null;
      const pic = await window
        .require('WAWebContactProfilePicThumbBridge')
        .requestProfilePicFromServer(chat);
      return pic?.eurl || null;
    } catch (err) {
      // No picture set, or not visible to us under their privacy settings.
      if (err.name === 'ServerStatusCodeError') return null;
      throw err;
    }
  }, chatId);
}

async function getAvatarUrl(client, chatId) {
  try {
    return (await getAvatarUrlFast(client, chatId)) || null;
  } catch (err) {
    console.warn(`[wa] fast avatar lookup failed (${err.message}), falling back`);
    try {
      return (await client.getProfilePicUrl(chatId)) || null;
    } catch {
      return null;
    }
  }
}

module.exports = {
  mapMessage,
  chatIdFor,
  listChats,
  listChatsFast,
  listChatsViaGetChats,
  fetchMessages,
  fetchMessagesFast,
  fetchMessagesViaChat,
  sendMessage,
  markRead,
  downloadMessageMedia,
  downloadMessageMediaFast,
  downloadMessageMediaViaMessage,
  sendMedia,
  getAvatarUrl,
};
