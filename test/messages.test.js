// Exercises the injected chat-listing function against a mock of WhatsApp's
// Chat/Msg collections, plus the pure message-shaping helpers. Doesn't need
// Mongo or a linked session.
const {
  listChats,
  fetchMessages,
  sendMessage,
  mapMessage,
  serializeMessageId,
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

  /** A message whose key carries the parts a real MsgKey has, not just an id. */
  function keyedMsg(shortId, { fromMe = false, t = 0, body = '' } = {}) {
    const remote = '212661234567@c.us';
    const serialized = `${fromMe}_${remote}_${shortId}`;
    return {
      id: { _serialized: serialized, fromMe, remote, id: shortId },
      t,
      body,
      isNotification: false,
      type: 'chat',
    };
  }

  /** A client whose pupPage.evaluate runs the fast path for real, against a
   * mocked WWebJS.getChat/getMessageModel and WAWebChatLoadMessages. */
  function fetchClient({
    msgs,
    getChatThrows = false,
    viaGetChatById,
    // Successive pages handed back by loadEarlierMsgs, oldest request first.
    pages = [],
    // Mimic getMessageModel dropping the key's _serialized, which is what it
    // does when it rebuilds the key around an object `remote`.
    stripSerialized = false,
  } = {}) {
    const remaining = [...pages];
    return {
      pupPage: {
        evaluate: async (fn, ...args) => {
          if (getChatThrows) throw new Error('r');
          global.window = {
            WWebJS: {
              getChat: async () => (msgs ? { msgs: { getModelsArray: () => msgs } } : null),
              getMessageModel: (m) =>
                stripSerialized
                  ? { ...m, id: { fromMe: m.id.fromMe, remote: {}, id: m.id.id } }
                  : m,
            },
            require: (mod) => {
              if (mod === 'WAWebChatLoadMessages') {
                return { loadEarlierMsgs: async () => remaining.shift() || [] };
              }
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

  // getMessageModel rebuilds the key with Object.assign when `remote` is a
  // Wid, and the serialized id does not always survive that copy. Every
  // message then came back with the same "[object Object]" id: the panel
  // unions a conversation by id, so an open chat collapsed to one bubble a
  // few seconds after it loaded, and media 404'd for all of them.
  messages = await fetchMessages(
    fetchClient({
      stripSerialized: true,
      msgs: [
        keyedMsg('AAA', { fromMe: false, t: 1, body: 'first' }),
        keyedMsg('BBB', { fromMe: true, t: 2, body: 'second' }),
      ],
    }),
    '212661234567@c.us',
    { limit: 50 }
  );
  check(
    'a stripped key keeps its serialized id',
    messages.length === 2 &&
      messages[0].id === 'false_212661234567@c.us_AAA' &&
      messages[1].id === 'true_212661234567@c.us_BBB',
    JSON.stringify(messages.map((m) => m.id))
  );
  check(
    'and every message keeps its OWN id',
    new Set(messages.map((m) => m.id)).size === messages.length
  );

  // Second line of defence: nothing recoverable in the page either, so the id
  // has to be rebuilt from the key's parts on this side.
  messages = await fetchMessages(
    fetchClient({
      msgs: [
        { id: { fromMe: false, remote: '212661234567@c.us', id: 'AAA' }, t: 1, type: 'chat' },
        { id: { fromMe: true, remote: '212661234567@c.us', id: 'BBB' }, t: 2, type: 'chat' },
      ],
    }),
    '212661234567@c.us',
    { limit: 50 }
  );
  check(
    'a key with no serialized form at all is rebuilt from its parts',
    messages[0].id === 'false_212661234567@c.us_AAA' &&
      messages[1].id === 'true_212661234567@c.us_BBB',
    JSON.stringify(messages.map((m) => m.id))
  );

  // A re-keyed chat emits a run of notifications; a page made of nothing else
  // used to abort the backfill, leaving a near-empty history for exactly the
  // chats that most needed one.
  messages = await fetchMessages(
    fetchClient({
      msgs: [rawMsg('newest', { t: 9, body: 'newest' })],
      pages: [
        [rawMsg('n1', { isNotification: true }), rawMsg('n2', { isNotification: true })],
        [rawMsg('older', { t: 1, body: 'older' })],
      ],
    }),
    '212661234567@c.us',
    { limit: 50 }
  );
  check(
    'a page of only notifications does not end the backfill',
    messages.length === 2 && messages.some((m) => m.body === 'older'),
    JSON.stringify(messages.map((m) => m.body))
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

  console.log('\n-- serializeMessageId --');
  check(
    'a serialized key is used as-is',
    serializeMessageId({ _serialized: 'true_212@c.us_ABC' }) === 'true_212@c.us_ABC'
  );
  check('a string id passes through', serializeMessageId('true_212@c.us_ABC') === 'true_212@c.us_ABC');
  check(
    'a DM key is rebuilt from its parts',
    serializeMessageId({ fromMe: true, remote: '212661234567@c.us', id: 'ABC' }) ===
      'true_212661234567@c.us_ABC',
    serializeMessageId({ fromMe: true, remote: '212661234567@c.us', id: 'ABC' })
  );
  check(
    'an incoming DM key rebuilds with false',
    serializeMessageId({ fromMe: false, remote: '212661234567@c.us', id: 'ABC' }) ===
      'false_212661234567@c.us_ABC'
  );
  check(
    'a group key keeps its participant as a fourth part',
    serializeMessageId({
      fromMe: false,
      remote: { _serialized: '12036@g.us' },
      id: 'ABC',
      participant: { _serialized: '212661234567@c.us' },
    }) === 'false_12036@g.us_ABC_212661234567@c.us'
  );
  // Anything is better than a string that every message shares.
  check('an unusable key is null, never "[object Object]"', serializeMessageId({}) === null);
  check('a missing key is null', serializeMessageId(undefined) === null);

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

  console.log('\n-- mapMessage: the body of a media message is a thumbnail --');
  // WhatsApp stores a base64 JPEG preview in `body` on media messages and the
  // caption in `caption`. Reading `body` as text rendered a photo as a wall
  // of base64 where its caption belonged.
  const THUMB = 'ffd8ffe0'.repeat(20); // base64-shaped and long enough to pass
  const withThumb = mapMessage({
    id: { _serialized: 'img3' },
    type: 'image',
    body: THUMB,
    caption: 'the real caption',
    t: 4,
  });
  check('the caption wins, never the thumbnail', withThumb.body === 'the real caption', withThumb.body);
  check('  and the thumbnail is offered as a data URI', withThumb.thumbnail === `data:image/jpeg;base64,${THUMB}`);

  const noCaption = mapMessage({ id: { _serialized: 'img4' }, type: 'image', body: THUMB });
  check('a photo with no caption has an empty body', noCaption.body === '', JSON.stringify(noCaption.body));

  // On a live Message the library has already resolved body to the caption,
  // and the raw model sits under _data.
  const liveThumb = mapMessage({
    id: { _serialized: 'img5' },
    type: 'image',
    hasMedia: true,
    body: 'live caption',
    _data: { body: THUMB },
  });
  check('a live Message keeps its resolved caption', liveThumb.body === 'live caption');
  check('  and still exposes the thumbnail', liveThumb.thumbnail === `data:image/jpeg;base64,${THUMB}`);

  check(
    'a voice note offers no thumbnail',
    mapMessage({ id: { _serialized: 'p2' }, type: 'ptt', body: THUMB }).thumbnail === null
  );
  check(
    'plain text is never mistaken for a thumbnail',
    mapMessage({ id: { _serialized: 't2' }, type: 'chat', body: 'hello' }).thumbnail === null
  );
  check(
    'a short or non-base64 body is not a thumbnail',
    mapMessage({ id: { _serialized: 'i6' }, type: 'image', body: 'hi!! not base64' }).thumbnail === null
  );

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
  // undefined is what produced "Cannot read properties of undefined"; giving
  // up and returning null left the sent message invisible until a reload.
  const lidClient = fetchClient({
    msgs: [rawMsg('old', { body: 'earlier', t: 1 }), rawMsg('new', { body: 'yo', t: 2, fromMe: true })],
  });
  lidClient.sendMessage = async () => undefined;
  sent = await sendMessage(lidClient, '133302967075006@lid', 'yo');
  check(
    'a missed post-send lookup reads the message back',
    sent && sent.id === 'new' && sent.fromMe === true,
    JSON.stringify(sent)
  );

  // If someone else's message landed in the gap, attributing it to us would
  // be worse than showing nothing.
  const racedClient = fetchClient({ msgs: [rawMsg('theirs', { body: 'hi', t: 3 })] });
  racedClient.sendMessage = async () => undefined;
  sent = await sendMessage(racedClient, '133302967075006@lid', 'yo');
  check('an incoming message is never claimed as ours', sent === null, JSON.stringify(sent));

  // A read-back that itself fails must not turn a delivered message into an
  // error response.
  const brokenClient = {
    sendMessage: async () => undefined,
    pupPage: {
      evaluate: async () => {
        throw new Error('r');
      },
    },
    getChatById: async () => {
      throw new Error('r');
    },
  };
  sent = await sendMessage(brokenClient, '133302967075006@lid', 'yo');
  check('a failed read-back degrades to null, not a throw', sent === null, String(sent));

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
