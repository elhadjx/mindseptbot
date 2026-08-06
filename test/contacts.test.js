// Exercises the injected contact-listing function against a mock of WhatsApp's
// Contact collection. Doesn't need Mongo or a linked session.
const { listContacts } = require('../src/whatsapp/contacts');

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
function fakeClient(contacts, { getContacts, missingGetters = false } = {}) {
  return {
    pupPage: {
      evaluate: async (fn) => {
        global.window = {
          require: (mod) => {
            if (mod === 'WAWebCollections') {
              return { Contact: { getModelsArray: () => contacts } };
            }
            // The panel must survive these modules moving or disappearing.
            if (missingGetters) throw new Error(`unexpected module ${mod}`);
            if (mod === 'WAWebContactGetters') {
              return {
                getIsMe: (c) => Boolean(c.isMe),
                getName: (c) => c.name,
                getPushname: (c) => c.pushname,
                getShortName: (c) => c.shortName,
                getIsWAContact: (c) => Boolean(c.isWAContact),
              };
            }
            if (mod === 'WAWebFrontendContactGetters') {
              return { getIsMyContact: (c) => Boolean(c.isMyContact) };
            }
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
    getContacts,
  };
}

function contact(id, extra = {}) {
  const [user, server] = id.split('@');
  return { id: { _serialized: id, user, server }, ...extra };
}

async function main() {
  console.log('\n-- filtering --');
  let contacts = await listContacts(
    fakeClient([
      contact('212661234567@c.us', { name: 'Amina', isMyContact: true, isWAContact: true }),
      contact('99988877766655@lid', { pushname: 'Bilal', isWAContact: true }),
      contact('120363000000000000@g.us', { name: 'A group' }),
      contact('0@broadcast', { name: 'Status' }),
      contact('212660000000@c.us', { name: 'Me', isMe: true }),
    ])
  );
  check('groups are excluded', !contacts.some((c) => c.waId.endsWith('@g.us')));
  check('broadcast is excluded', !contacts.some((c) => c.waId.endsWith('@broadcast')));
  check('the account itself is excluded', !contacts.some((c) => c.name === 'Me'));
  check('people are kept', contacts.length === 2, JSON.stringify(contacts.map((c) => c.waId)));

  console.log('\n-- projection --');
  const amina = contacts.find((c) => c.waId === '212661234567@c.us');
  check('phone is read off a c.us id', amina.phone === '212661234567', amina.phone);
  check('  and lid is null there', amina.lid === null);
  check('  saved contacts are flagged', amina.isMyContact === true);
  check('  label prefers the saved name', amina.label === 'Amina', amina.label);

  const bilal = contacts.find((c) => c.waId === '99988877766655@lid');
  check('a LID contact keeps its lid', bilal.lid === '99988877766655@lid');
  check('  and reports no phone rather than a fake one', bilal.phone === null, String(bilal.phone));
  check('  label falls back to the pushname', bilal.label === 'Bilal', bilal.label);
  check('  not saved in the address book', bilal.isMyContact === false);

  console.log('\n-- a LID contact whose number WhatsApp did resolve --');
  contacts = await listContacts(
    fakeClient([
      contact('99988877766655@lid', { phoneNumber: { user: '213549212025' }, name: 'Karim' }),
    ])
  );
  check('the resolved number is used', contacts[0].phone === '213549212025', contacts[0].phone);

  console.log('\n-- nameless contact --');
  contacts = await listContacts(fakeClient([contact('213549212025@c.us', {})]));
  check('falls back to the number', contacts[0].label === '+213549212025', contacts[0].label);

  console.log('\n-- one bad contact must not kill the list --');
  const exploding = {
    get id() {
      throw new Error('boom');
    },
  };
  contacts = await listContacts(
    fakeClient([exploding, contact('212661234567@c.us', { name: 'Survivor' })])
  );
  check('the good contact still comes back', contacts.length === 1 && contacts[0].name === 'Survivor');

  console.log('\n-- getter modules missing --');
  contacts = await listContacts(
    fakeClient([contact('212661234567@c.us', { name: 'Amina', isMyContact: true })], {
      missingGetters: true,
    })
  );
  check('reads straight off the model instead', contacts.length === 1 && contacts[0].name === 'Amina');
  check('  including the saved-contact flag', contacts[0].isMyContact === true);

  console.log('\n-- fallback when the page query fails --');
  const broken = {
    pupPage: {
      evaluate: async () => {
        // What WhatsApp's minified bundle actually throws at us.
        throw new Error('r');
      },
    },
    getContacts: async () => [
      { id: { _serialized: '212661234567@c.us' }, name: 'Via getContacts', number: '212661234567', isMyContact: true },
      { id: { _serialized: '120363000000000000@g.us' }, name: 'A group', isGroup: true },
      { id: { _serialized: '212660000000@c.us' }, name: 'Me', isMe: true },
    ],
  };
  contacts = await listContacts(broken);
  check('falls back to getContacts()', contacts.length === 1 && contacts[0].name === 'Via getContacts');
  check('  and still filters groups and self', !contacts.some((c) => c.name === 'Me'));

  console.log('\n-- sorting --');
  contacts = await listContacts(
    fakeClient([
      contact('212661111111@c.us', { name: 'Zineb' }),
      contact('212662222222@c.us', { name: 'Amine' }),
    ])
  );
  check('sorted by label', contacts[0].name === 'Amine', contacts[0].name);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
