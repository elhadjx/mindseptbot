const path = require('path');
// Exercises the full message pipeline against the real Mongo, with the Tuya
// call stubbed out so no physical relay fires.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Module = require('module');

const doorServicePath = path.resolve(__dirname, '../src/doors/door-service.js');
const opens = [];

// Stub triggerDoor before anything requires it.
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try {
      return Module._resolveFilename(request, parent);
    } catch {
      return null;
    }
  })();
  if (resolved === doorServicePath) {
    return {
      DOORS: { front: { label: 'Front door', deviceId: 'stub', dpCode: 'switch_1' } },
      listDoors: () => [{ key: 'front', label: 'Front door', configured: true }],
      triggerDoor: async (key) => {
        opens.push(key);
      },
    };
  }
  return realLoad(request, parent, isMain);
};

const { connectMongo, mongoose } = require('../src/db/mongo');
const Settings = require('../src/db/models/Settings');
const User = require('../src/db/models/User');
const AuditLog = require('../src/db/models/AuditLog');
const { handleMessage } = require('../src/whatsapp/handlers');
const rateLimiter = require('../src/whatsapp/rate-limiter');

const GROUP = '120363000000000000@g.us';
const SECOND_GROUP = '120363111111111111@g.us';
const DISABLED_GROUP = '120363222222222222@g.us';
const OTHER_GROUP = '120363999999999999@g.us';

// A client stub: identity resolution falls back to parsing the JID, which is
// exactly what happens when the browser can't resolve a LID.
const client = { pupPage: null };

let n = 0;
function makeMsg({ from = GROUP, author, body, ageSec = 0 }) {
  const reactions = [];
  const replies = [];
  return {
    from,
    author,
    body,
    timestamp: Math.floor(Date.now() / 1000) - ageSec,
    id: { _serialized: `msg-${++n}` },
    react: async (e) => reactions.push(e),
    reply: async (t) => replies.push(t),
    getContact: async () => ({ pushname: 'Test User' }),
    reactions,
    replies,
  };
}

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

async function main() {
  await connectMongo();

  // Clean slate on a scratch database.
  await Promise.all([User.deleteMany({}), AuditLog.deleteMany({}), Settings.deleteMany({})]);
  rateLimiter.reset();

  const settings = await Settings.load();
  settings.groups = [
    { id: GROUP, name: 'Door group', enabled: true },
    { id: DISABLED_GROUP, name: 'Paused group', enabled: false },
  ];
  settings.replyMode = 'both';
  await settings.save();

  const allowed = await User.create({
    waId: '212661111111@c.us',
    phone: '212661111111',
    displayName: 'Allowed Person',
  });
  await User.create({
    waId: '99988877766655@lid',
    lid: '99988877766655@lid',
    displayName: 'LID Person',
  });
  await User.create({
    waId: '212662222222@c.us',
    phone: '212662222222',
    displayName: 'Disabled Person',
    enabled: false,
  });

  console.log('\n-- scope --');
  let m = makeMsg({ from: OTHER_GROUP, author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check('command in another group is ignored', opens.length === 0 && (await AuditLog.countDocuments()) === 0);

  m = makeMsg({ from: '212661111111@c.us', author: undefined, body: '/open' });
  await handleMessage(client, m);
  check('command in a DM is ignored', opens.length === 0 && (await AuditLog.countDocuments()) === 0);

  m = makeMsg({ from: DISABLED_GROUP, author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check(
    'command in a disabled group is ignored',
    opens.length === 0 && (await AuditLog.countDocuments()) === 0
  );

  console.log('\n-- freshness --');
  m = makeMsg({ author: '212661111111@c.us', body: '/open', ageSec: 600 });
  await handleMessage(client, m);
  check('stale command does not open', opens.length === 0);
  check('stale command is not logged', (await AuditLog.countDocuments()) === 0);

  console.log('\n-- parsing --');
  for (const body of ['hello everyone', 'je peux pas ouvre la porte', 'reopen']) {
    m = makeMsg({ author: '212661111111@c.us', body });
    await handleMessage(client, m);
  }
  check('non-command chatter is ignored', opens.length === 0 && (await AuditLog.countDocuments()) === 0);

  console.log('\n-- authorization --');
  m = makeMsg({ author: '212669999999@c.us', body: '/open' });
  await handleMessage(client, m);
  check('unknown number denied', opens.length === 0);
  check('  reacted with the deny emoji', m.reactions[0] === '⛔', `got ${m.reactions[0]}`);
  let log = await AuditLog.findOne().sort({ at: -1 });
  check('  denial logged with reason', log?.decision === 'denied' && log?.reason === 'not_whitelisted');
  check('  denial records the actor', log?.actorPhone === '212669999999');

  m = makeMsg({ author: '212662222222@c.us', body: '/open' });
  await handleMessage(client, m);
  check('disabled member denied', opens.length === 0);

  console.log('\n-- granted --');
  m = makeMsg({ author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check('whitelisted member opens the door', opens.length === 1 && opens[0] === 'front');
  check('  reacted with the granted emoji', m.reactions[0] === '✅');
  check('  replied in the group', m.replies.length === 1);
  log = await AuditLog.findOne().sort({ at: -1 });
  check('  granted logged', log?.decision === 'granted' && log?.door === 'front');
  check('  duration recorded', typeof log?.durationMs === 'number');
  const refreshed = await User.findById(allowed._id);
  check('  lastOpenedAt updated', Boolean(refreshed.lastOpenedAt));

  console.log('\n-- LID-addressed sender --');
  m = makeMsg({ author: '99988877766655@lid', body: 'ouvre' });
  await handleMessage(client, m);
  check('LID member opens the door', opens.length === 2);

  console.log('\n-- multiple groups --');
  rateLimiter.reset();
  settings.groups.push({ id: SECOND_GROUP, name: 'Second door', enabled: true });
  await settings.save();
  const beforeSecond = opens.length;
  m = makeMsg({ from: SECOND_GROUP, author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check('a second enabled group also opens', opens.length - beforeSecond === 1);
  log = await AuditLog.findOne().sort({ at: -1 });
  check('  log records which group it came from', log?.groupId === SECOND_GROUP);

  // Toggling a group off must take effect without a restart.
  settings.groups = settings.groups.map((g) =>
    g.id === SECOND_GROUP ? { ...g.toObject?.() ?? g, enabled: false } : g
  );
  await settings.save();
  rateLimiter.reset();
  const beforeToggle = opens.length;
  m = makeMsg({ from: SECOND_GROUP, author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check('disabling a group takes effect immediately', opens.length === beforeToggle);

  console.log('\n-- keyword variants --');
  // Reset between each so the per-user limit doesn't mask a parsing failure -
  // rate limiting is covered separately below.
  const variants = ['OUVRE', 'Porte', '/open front', 'open  '];
  const beforeVariants = opens.length;
  for (const body of variants) {
    rateLimiter.reset();
    const msg = makeMsg({ author: '212661111111@c.us', body });
    await handleMessage(client, msg);
  }
  check(
    'case/accent/arg variants all match',
    opens.length - beforeVariants === variants.length,
    `opened ${opens.length - beforeVariants}/${variants.length}`
  );

  console.log('\n-- rate limiting --');
  rateLimiter.reset();
  const before = opens.length;
  const msgs = [];
  for (let i = 0; i < 5; i++) {
    const msg = makeMsg({ author: '212661111111@c.us', body: '/open' });
    await handleMessage(client, msg);
    msgs.push(msg);
  }
  check('per-user limit caps opens at 3', opens.length - before === 3, `got ${opens.length - before}`);
  check('  4th attempt denied', msgs[3].reactions[0] === '⛔');
  log = await AuditLog.findOne({ decision: 'denied' }).sort({ at: -1 });
  check('  rate-limit denial logged with reason', /rate_limited_user/.test(log?.reason || ''), log?.reason);

  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
