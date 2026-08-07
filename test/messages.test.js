// Exercises the injected chat-listing function against a mock of WhatsApp's
// Chat/Msg collections, plus the pure message-shaping helpers. Doesn't need
// Mongo or a linked session.
const {
  listChats,
  fetchMessages,
  sendMessage,
  mapMessage,
  chatIdFor,
} = require('../src/whatsapp/messages');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function chat(id, name, { unreadCount = 0, t = 0, lastReceivedKey } = {}) {
  const [user, server] = id.split('@');
  return {
    id: { _serialized: id, user, server },
    formattedTitle: name,
    unreadCount,
    t,
    lastReceivedKey: lastReceivedKey ? { _serialized: lastReceivedKey } : undefined,
  };
}

/** A client whose pupPage.evaluate really runs the function against `mockWindow`. */
function fakeClient(chats, { msgs = {}, getChats } = {}) {
  return {
    pupPage: {
      evaluate: async (fn) => {
        global.window = {
          require: (mod) => {
            if (mod === 'WAWebCollections') {
              return {
                Chat: { getModelsArray: () => chats },
                Msg: {
                  get: (id) => msgs[id] || null,
                  getMessagesById: async () => ({ messages: [] }),
                },
              };
            }
            throw new Error(`unexpected module ${mod}`);
          },
          WWebJS: {
            getMessageModel: (raw) => raw,
          },
        };
        try {
          return await fn();
        } finally {
          delete global.window;
        }
      },
    },
    getChats,
  };
}

async function main() {
  console.log('\n-- filtering --');
  let chats = await listChats(
    fakeClient([
      chat('120363000000000000@g.us', 'Door group', { unreadCount: 2, t: 100 }),
      chat('212661234567@c.us', 'A person', { t: 200 }),
      chat('99988877766655@lid', 'A LID contact', { t: 50 }),
      chat('0@broadcast', 'Status'),
      chat('120@newsletter', 'A channel'),
    ])
  );
  check('groups and DMs are kept', chats.length === 3, JSON.stringify(chats.map((c) => c.id)));
  check('broadcast is excluded', !chats.some((c) => c.id.endsWith('@broadcast')));
  check('channels are excluded', !chats.some((c) => c.id.endsWith('@newsletter')));
  check('isGroup is flagged for @g.us', chats.find((c) => c.id.endsWith('@g.us')).isGroup === true);
  check('isGroup is false for DMs', chats.find((c) => c.id.endsWith('@c.us')).isGroup === false);
  check('unread count comes through', chats.find((c) => c.name === 'Door group').unreadCount === 2);

  console.log('\n-- sorting --');
  check('newest activity first', chats[0].name === 'A person', chats[0].name);
  check('  then the door group', chats[1].name === 'Door group', chats[1].name);

  console.log('\n-- unnamed group --');
  chats = await listChats(fakeClient([chat('120363000000000000@g.us', '')]));
  check('unnamed groups get a placeholder', chats[0].name === '(unnamed group)', chats[0].name);

  console.log('\n-- last message preview --');
  chats = await listChats(
    fakeClient(
      [chat('212661234567@c.us', 'A person', { lastReceivedKey: 'msg1' })],
      { msgs: { msg1: { body: 'Salut', t: 123, id: { fromMe: false }, type: 'chat' } } }
    )
  );
  check('preview body comes through', chats[0].lastMessage.body === 'Salut');
  check('  and fromMe', chats[0].lastMessage.fromMe === false);

  console.log('\n-- one bad chat must not kill the list --');
  const exploding = {
    get id() {
      throw new Error('boom');
    },
  };
  chats = await listChats(
    fakeClient([exploding, chat('212661234567@c.us', 'Survivor')])
  );
  check('the good chat still comes back', chats.length === 1 && chats[0].name === 'Survivor');

  console.log('\n-- fallback when the page query fails --');
  const broken = {
    pupPage: {
      evaluate: async () => {
        throw new Error('r');
      },
    },
    getChats: async () => [
      {
        isGroup: false,
        id: { _serialized: '212661234567@c.us', server: 'c.us' },
        name: 'Via getChats',
        unreadCount: 1,
        timestamp: 10,
      },
      {
        isGroup: false,
        id: { _serialized: '0@broadcast', server: 'broadcast' },
        name: 'Status',
      },
    ],
  };
  chats = await listChats(broken);
  check('falls back to getChats()', chats.length === 1 && chats[0].name === 'Via getChats');
  check('  and still filters broadcast', !chats.some((c) => c.id.endsWith('@broadcast')));

  console.log('\n-- fetchMessages --');

  function rawMsg(id, { fromMe = false, t = 0, body = '', isNotification = false } = {}) {
    return { id: { _serialized: id, fromMe }, t, body, isNotification, type: 'chat' };
  }

  /** A client whose pupPage.evaluate runs the fast path for real, against a
   * mocked WWebJS.getChat/getMessageModel and WAWebChatLoadMessages. */
  function fetchClient({ msgs, getChatThrows = false, viaGetChatById } = {}) {
    return {
      pupPage: {
        evaluate: async (fn, ...args) => {
          if (getChatThrows) throw new Error('r');
          global.window = {
            WWebJS: {
              getChat: async () => (msgs ? { msgs: { getModelsArray: () => msgs } } : null),
              getMessageModel: (m) => m,
            },
            require: (mod) => {
              if (mod === 'WAWebChatLoadMessages') return { loadEarlierMsgs: async () => [] };
              throw new Error(`unexpected module ${mod}`);
            },
          };
          try {
            return await fn(...args);
          } finally {
            delete global.window;
          }
        },
      },
      getChatById: async () => viaGetChatById,
    };
  }

  let messages = await fetchMessages(
    fetchClient({
      msgs: [
        rawMsg('a', { body: 'hi', t: 1 }),
        rawMsg('note', { isNotification: true }),
        rawMsg('b', { body: 'bye', t: 2, fromMe: true }),
      ],
    }),
    '212661234567@c.us',
    { limit: 50 }
  );
  check('notifications are filtered out', messages.length === 2, JSON.stringify(messages));
  check('order and fields survive', messages[0].body === 'hi' && messages[1].fromMe === true);

  check(
    'an unknown chat returns null',
    (await fetchMessages(fetchClient({ msgs: null }), '99999@c.us')) === null
  );

  console.log('\n-- fetchMessages fallback --');
  messages = await fetchMessages(
    fetchClient({
      getChatThrows: true,
      viaGetChatById: {
        fetchMessages: async () => [
          { id: { _serialized: 'x' }, fromMe: false, timestamp: 5, body: 'via getChatById', type: 'chat' },
        ],
      },
    }),
    '212661234567@c.us'
  );
  check(
    'falls back to getChatById().fetchMessages()',
    messages.length === 1 && messages[0].body === 'via getChatById',
    JSON.stringify(messages)
  );

  console.log('\n-- mapMessage --');
  const mapped = mapMessage({
    id: { _serialized: '212@c.us_ABC' },
    body: 'hey',
    timestamp: 111,
    fromMe: true,
    author: null,
    type: 'chat',
    hasMedia: false,
    ack: 3,
  });
  check('id is serialized', mapped.id === '212@c.us_ABC');
  check('fromMe passes through', mapped.fromMe === true);

  console.log('\n-- mapMessage: media detection --');
  // A serialized model carries neither `hasMedia` nor, reliably, a top-level
  // directPath - getting this wrong renders a photo as an empty text bubble.
  const rawImage = mapMessage({
    id: { _serialized: 'img1', fromMe: false },
    type: 'image',
    caption: 'at the door',
    t: 9,
  });
  check('a serialized image counts as media', rawImage.hasMedia === true);
  check('  and its caption becomes the body', rawImage.body === 'at the door', rawImage.body);

  const rawVoice = mapMessage({ id: { _serialized: 'ptt1' }, type: 'ptt', t: 9 });
  check('a voice note counts as media', rawVoice.hasMedia === true);

  const liveImage = mapMessage({
    id: { _serialized: 'img2' },
    type: 'image',
    hasMedia: true,
    body: 'already folded in',
  });
  check('a live Message keeps its folded-in caption', liveImage.body === 'already folded in');

  const doc = mapMessage({
    id: { _serialized: 'doc1' },
    type: 'document',
    filename: 'lease.pdf',
    mimetype: 'application/pdf',
  });
  check('documents carry their filename', doc.filename === 'lease.pdf');
  check('  and mimetype', doc.mimetype === 'application/pdf');

  const plain = mapMessage({ id: { _serialized: 't1' }, type: 'chat', body: 'hello' });
  check('a plain text message is not media', plain.hasMedia === false);

  const objAuthor = mapMessage({
    id: { _serialized: 'g1' },
    type: 'chat',
    author: { _serialized: '212661234567@c.us' },
  });
  check('an object author is serialized', objAuthor.author === '212661234567@c.us', String(objAuthor.author));

  console.log('\n-- sendMessage --');
  let sent = await sendMessage(
    { sendMessage: async () => ({ id: { _serialized: 'new1', fromMe: true }, body: 'yo', type: 'chat' }) },
    '212661234567@c.us',
    'yo'
  );
  check('a sent message is mapped', sent.id === 'new1' && sent.body === 'yo');

  // whatsapp-web.js looks the sent message back up by its new key and returns
  // undefined when that misses - the message is already gone out. Mapping the
  // undefined is what produced "Cannot read properties of undefined".
  sent = await sendMessage({ sendMessage: async () => undefined }, '133302967075006@lid', 'yo');
  check('a missing post-send model is null, not a throw', sent === null, String(sent));

  console.log('\n-- chatIdFor --');
  check(
    'a received message uses from',
    chatIdFor({ fromMe: false, from: '212661234567@c.us', to: '212660000000@c.us' }) ===
      '212661234567@c.us'
  );
  check(
    'a sent message uses to',
    chatIdFor({ fromMe: true, from: '212660000000@c.us', to: '212661234567@c.us' }) ===
      '212661234567@c.us'
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
