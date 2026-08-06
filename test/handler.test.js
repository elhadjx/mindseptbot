const path = require('path');
// Exercises the full message pipeline against the real Mongo, with the Tuya
// call stubbed out so no physical relay fires.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Module = require('module');

const doorServicePath = path.resolve(__dirname, '../src/doors/door-service.js');
const opens = [];
const simulatedOpens = [];

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
      // Mirrors the real signature: honour `simulate` and report it back, so
      // the test exercises the same branch production does.
      triggerDoor: async (key, { simulate = false } = {}) => {
        if (simulate) {
          simulatedOpens.push(key);
          return { simulated: true };
        }
        opens.push(key);
        return { simulated: false };
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
const { backfillPhones } = require('../src/whatsapp/phone');
const rateLimiter = require('../src/whatsapp/rate-limiter');

const GROUP = '120363000000000000@g.us';
const SECOND_GROUP = '120363111111111111@g.us';
const DISABLED_GROUP = '120363222222222222@g.us';
const OTHER_GROUP = '120363999999999999@g.us';

// A client stub: identity resolution falls back to parsing the JID, which is
// exactly what happens when the browser can't resolve a LID.
const client = { pupPage: null };

let n = 0;
function makeMsg({ from = GROUP, author, body, ageSec = 0, fromMe = false }) {
  const reactions = [];
  const replies = [];
  return {
    from,
    author,
    body,
    fromMe,
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

  console.log('\n-- configurable replies --');
  rateLimiter.reset();
  settings.replies.granted = { emoji: '🚀', text: 'Salut {name}, {door} ouverte !' };
  settings.replies.denied_not_whitelisted = { emoji: '', text: '' };
  settings.markModified('replies');
  await settings.save();

  m = makeMsg({ author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check('custom reaction is used', m.reactions[0] === '🚀', m.reactions[0]);
  check('  {name} is substituted', /Allowed Person/.test(m.replies[0] || ''), m.replies[0]);
  check('  {door} is substituted', /Front door/.test(m.replies[0] || ''), m.replies[0]);

  // Blank emoji and blank text mean "stay quiet", not "fall back to default".
  m = makeMsg({ author: '212669999999@c.us', body: '/open' });
  await handleMessage(client, m);
  check('blank reply sends no reaction', m.reactions.length === 0, JSON.stringify(m.reactions));
  check('  and no message', m.replies.length === 0, JSON.stringify(m.replies));
  log = await AuditLog.findOne().sort({ at: -1 });
  check('  but the denial is still logged', log?.decision === 'denied' && log?.reason === 'not_whitelisted');

  // Restore so later sections see predictable output.
  settings.replies.granted = { emoji: '✅', text: 'Ouvert 🚪' };
  settings.replies.denied_not_whitelisted = { emoji: '⛔', text: 'Pas sur la liste.' };
  settings.markModified('replies');
  await settings.save();

  console.log('\n-- test mode --');
  rateLimiter.reset();
  settings.testMode = true;
  await settings.save();
  const realOpensBefore = opens.length;
  m = makeMsg({ author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check('test mode does not touch the relay', opens.length === realOpensBefore);
  check('  but the pipeline still ran', simulatedOpens.length === 1);
  check('  reacted with the test emoji, not the granted one', m.reactions[0] === '🧪', m.reactions[0]);
  check('  told the sender the door did not open', /pas/i.test(m.replies[0] || ''), m.replies[0]);
  log = await AuditLog.findOne().sort({ at: -1 });
  check('  logged as simulated', log?.simulated === true);
  check('  and still recorded as granted', log?.decision === 'granted');

  // Turning it off must take effect immediately, without a restart.
  settings.testMode = false;
  await settings.save();
  rateLimiter.reset();
  m = makeMsg({ author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check('turning test mode off opens for real again', opens.length === realOpensBefore + 1);
  log = await AuditLog.findOne().sort({ at: -1 });
  check('  and that entry is not marked simulated', log?.simulated === false);

  console.log('\n-- direct messages --');
  // A DM has no author: msg.from IS the sender.
  const DM = '212661111111@c.us';
  const STRANGER_DM = '212669999999@c.us';
  const LID_DM = '99988877766655@lid';

  rateLimiter.reset();
  let logsBefore = await AuditLog.countDocuments();
  let opensBefore = opens.length;
  m = makeMsg({ from: DM, body: '/open' });
  await handleMessage(client, m);
  check('DMs are ignored while the setting is off', opens.length === opensBefore);
  check('  and not logged', (await AuditLog.countDocuments()) === logsBefore);

  settings.allowDirectMessages = true;
  await settings.save();

  rateLimiter.reset();
  m = makeMsg({ from: DM, body: '/open' });
  await handleMessage(client, m);
  check('a member can open from a DM once enabled', opens.length - opensBefore === 1);
  log = await AuditLog.findOne().sort({ at: -1 });
  check('  logged as a dm', log?.chatType === 'dm', log?.chatType);
  check('  chatId is the sender', log?.chatId === DM, log?.chatId);
  check('  groupId stays empty for a DM', log?.groupId === null, String(log?.groupId));

  rateLimiter.reset();
  opensBefore = opens.length;
  m = makeMsg({ from: LID_DM, body: 'ouvre' });
  await handleMessage(client, m);
  check('a LID-addressed DM works too', opens.length - opensBefore === 1);

  // The stranger case: logged so an admin can see the attempt, but silent, so
  // the bot never confirms itself to someone guessing numbers.
  rateLimiter.reset();
  logsBefore = await AuditLog.countDocuments();
  m = makeMsg({ from: STRANGER_DM, body: '/open' });
  await handleMessage(client, m);
  check('a stranger DM is denied silently', m.reactions.length === 0 && m.replies.length === 0);
  check('  but still logged', (await AuditLog.countDocuments()) === logsBefore + 1);
  log = await AuditLog.findOne().sort({ at: -1 });
  check('  with the reason', log?.decision === 'denied' && log?.reason === 'not_whitelisted');
  check('  and marked as a dm', log?.chatType === 'dm');

  // A group denial must still be answered - nothing about DMs changed that.
  rateLimiter.reset();
  m = makeMsg({ author: '212669999999@c.us', body: '/open' });
  await handleMessage(client, m);
  check('group denials still get a reaction', m.reactions[0] === '⛔', m.reactions[0]);

  console.log('\n-- out of scope even with DMs on --');
  rateLimiter.reset();
  logsBefore = await AuditLog.countDocuments();
  opensBefore = opens.length;
  for (const from of ['status@broadcast', '120363000000000000@broadcast', 'abc@newsletter']) {
    m = makeMsg({ from, body: '/open' });
    await handleMessage(client, m);
  }
  m = makeMsg({ from: DM, body: '/open', fromMe: true });
  await handleMessage(client, m);
  m = makeMsg({ from: DM, body: '/open', ageSec: 600 });
  await handleMessage(client, m);
  check(
    'status, broadcast, channels, own and stale messages all ignored',
    opens.length === opensBefore
  );
  check('  and none of them logged', (await AuditLog.countDocuments()) === logsBefore);

  rateLimiter.reset();
  opensBefore = opens.length;
  m = makeMsg({ author: '212661111111@c.us', body: '/open' });
  await handleMessage(client, m);
  check('groups still work with DMs enabled', opens.length - opensBefore === 1);

  settings.allowDirectMessages = false;
  await settings.save();
  rateLimiter.reset();
  opensBefore = opens.length;
  m = makeMsg({ from: DM, body: '/open' });
  await handleMessage(client, m);
  check('turning DMs back off takes effect immediately', opens.length === opensBefore);

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
  // Rate limiting gets its own emoji: "wait", not "never".
  check('  4th attempt denied', msgs[3].reactions[0] === '⏳', msgs[3].reactions[0]);
  log = await AuditLog.findOne({ decision: 'denied' }).sort({ at: -1 });
  check('  rate-limit denial logged with reason', /rate_limited_user/.test(log?.reason || ''), log?.reason);

  console.log('\n-- phone backfill --');
  const national = await User.create({
    waId: '0549212025@c.us',
    phone: '0549212025',
    displayName: 'National Number',
  });
  const foreign = await User.create({
    waId: '33612345678@c.us',
    phone: '33612345678',
    displayName: 'Foreign Member',
  });
  // A LID member whose phone was typed in national format: the phone is fixed,
  // the waId is not, because that JID is what WhatsApp actually sends.
  const lidMember = await User.create({
    waId: '77766655544433@lid',
    lid: '77766655544433@lid',
    phone: '0549333222',
    displayName: 'Lid Member',
  });
  // Collision: this one normalises straight onto an existing row.
  await User.create({ phone: '213777000111', waId: '213777000111@c.us', displayName: 'Already Canonical' });
  const dupe = await User.create({ phone: '0777000111', waId: '0777000111@c.us', displayName: 'Same Person Again' });

  const summary = await backfillPhones(User, '213');

  let after = await User.findById(national._id);
  check('national number is normalised', after.phone === '213549212025', after.phone);
  check('  and its derived waId with it', after.waId === '213549212025@c.us', after.waId);

  after = await User.findById(foreign._id);
  check('a foreign number is left alone', after.phone === '33612345678', after.phone);
  check('  and so is its waId', after.waId === '33612345678@c.us', after.waId);

  after = await User.findById(lidMember._id);
  check('a LID member gets its phone fixed', after.phone === '213549333222', after.phone);
  check('  but the LID waId is never rewritten', after.waId === '77766655544433@lid', after.waId);

  after = await User.findById(dupe._id);
  check('a colliding row is skipped, not lost', after.phone === '0777000111', after.phone);
  check('  and reported', summary.skipped === 1, JSON.stringify(summary));
  check('  the other two normalised', summary.updated === 2, JSON.stringify(summary));

  // Idempotent: a second pass has nothing left to do.
  const second = await backfillPhones(User, '213');
  check('running it again changes nothing', second.updated === 0, JSON.stringify(second));

  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
