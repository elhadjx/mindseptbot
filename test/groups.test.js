// Exercises the injected group-listing function by running it against a mock of
// WhatsApp's Chat collection. Doesn't need Mongo or a linked session.
const { listGroups } = require('../src/whatsapp/groups');

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

/** A client whose pupPage.evaluate really runs the function against `mockWindow`. */
function fakeClient(chats, { getChats } = {}) {
  return {
    pupPage: {
      evaluate: async (fn) => {
        global.window = {
          require: (mod) => {
            if (mod === 'WAWebCollections') return { Chat: { getModelsArray: () => chats } };
            throw new Error(`unexpected module ${mod}`);
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

function chat(id, name, participants) {
  const [user, server] = id.split('@');
  return {
    id: { _serialized: id, user, server },
    formattedTitle: name,
    groupMetadata: participants ? { participants } : undefined,
  };
}

async function main() {
  console.log('\n-- filtering --');
  let groups = await listGroups(
    fakeClient([
      chat('120363000000000000@g.us', 'Door group', [{}, {}, {}]),
      chat('212661234567@c.us', 'A person'),
      chat('120363111111111111@g.us', 'Résidence', [{}, {}]),
      chat('0@broadcast', 'Status'),
    ])
  );
  check('only @g.us chats are returned', groups.length === 2, JSON.stringify(groups.map((g) => g.id)));
  check('DMs are excluded', !groups.some((g) => g.id.endsWith('@c.us')));
  check('participant counts come through', groups.find((g) => g.name === 'Door group').participantCount === 3);
  check('sorted by name', groups[0].name === 'Door group', groups[0].name);

  console.log('\n-- missing metadata --');
  groups = await listGroups(fakeClient([chat('120363000000000000@g.us', 'No metadata')]));
  check(
    'unknown participant count is null, not 0',
    groups[0].participantCount === null,
    String(groups[0].participantCount)
  );

  console.log('\n-- unnamed group --');
  groups = await listGroups(fakeClient([chat('120363000000000000@g.us', '')]));
  check('unnamed groups get a placeholder', groups[0].name === '(unnamed group)', groups[0].name);

  console.log('\n-- one bad chat must not kill the list --');
  const exploding = {
    get id() {
      throw new Error('boom');
    },
  };
  groups = await listGroups(
    fakeClient([exploding, chat('120363000000000000@g.us', 'Survivor', [{}])])
  );
  check('the good group still comes back', groups.length === 1 && groups[0].name === 'Survivor');

  console.log('\n-- fallback when the page query fails --');
  const broken = {
    pupPage: {
      evaluate: async () => {
        // What WhatsApp's minified bundle actually threw at us.
        throw new Error('r');
      },
    },
    getChats: async () => [
      {
        isGroup: true,
        id: { _serialized: '120363000000000000@g.us' },
        name: 'Via getChats',
        participants: [{}, {}],
      },
      { isGroup: false, id: { _serialized: '212661234567@c.us' }, name: 'DM' },
    ],
  };
  groups = await listGroups(broken);
  check('falls back to getChats()', groups.length === 1 && groups[0].name === 'Via getChats');
  check('  and still filters out DMs', !groups.some((g) => g.id.endsWith('@c.us')));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
