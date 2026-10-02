const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { compileFunction } = require('node:vm');
const { renderReply, defaultReplies } = require('../src/whatsapp/replies');

// Exercise the real handler without opening a database, contacting AI, sending
// WhatsApp messages, or operating a relay.
function harness({ scope = 'dm', authorized = true, generated = 'Welcome, the door is open.',
  settings: overrides = {}, doorError = null, gifError = null, doorResult = {} } = {}) {
  const calls = { ai: [], doors: [], audit: [], order: [] };
  const settings = {
    chatScope: () => scope,
    maxMessageAgeSec: 90,
    replyMode: 'both',
    replies: defaultReplies(),
    aiRepliesEnabled: true,
    aiProvider: 'gemini',
    ...overrides,
  };
  const msg = {
    from: scope === 'group' ? 'fixture@g.us' : '123@c.us',
    body: '/open',
    timestamp: Date.now() / 1000,
    id: { _serialized: 'fixture-message' },
    reactions: [], replies: [],
    react: async (emoji) => msg.reactions.push(emoji),
    reply: async (text) => msg.replies.push(text),
  };
  const dependencies = {
    '../db/models/Settings': { load: async () => settings },
    '../db/models/User': {
      findAuthorized: async () => authorized ? { _id: 'member', displayName: 'Nadia' } : null,
      updateOne: async () => {},
    },
    '../db/models/AuditLog': { create: async (entry) => { calls.audit.push(entry); return entry; } },
    '../doors/door-service': {
      DOORS: { front: { label: 'Front door' } },
      triggerDoor: async (...args) => {
        calls.doors.push(args);
        calls.order.push('door');
        if (doorError) throw doorError;
        return { simulated: false, unconfirmed: false, ...doorResult };
      },
    },
    '../doors/offline-alert': { reportDoorOnline() {}, reportDoorOffline: async () => {} },
    '../events': { bus: { emit() {} }, EVENTS: { DOOR_OPENED: 'opened' } },
    './command-router': { parseCommand: () => ({ door: 'front', raw: '/open' }) },
    './confirmations': { rememberQuestion() {} },
    './identity': { identifyMessageSender: async () => ({ waId: '123@c.us', name: 'Nadia' }) },
    './replies': { renderReply },
    '../ai/door-ai': { doorAI: { rewriteReply: async (input) => {
      calls.ai.push(input);
      calls.order.push('ai');
      return typeof generated === 'string' ? { mode: 'text', reply: generated } : generated;
    } } },
    './gif-replies': { sendGifReply: async () => { if (gifError) throw gifError; } },
    './rate-limiter': { take: () => ({ allowed: true }) },
    './request-cooldown': { remainingMs: () => 0, take: () => ({ allowed: true }) },
  };
  const filename = path.resolve(__dirname, '../src/whatsapp/handlers.js');
  const module = { exports: {} };
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'console'], { filename })(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    { log() {}, warn() {}, error() {} }
  );
  return { msg, calls, settings, run: () => module.exports.handleMessage(null, msg) };
}

for (const scope of ['group', 'dm']) {
  test(`whitelisted ${scope} commands receive AI replies after the door result`, async () => {
    const h = harness({ scope });
    await h.run();
    assert.deepEqual(h.msg.reactions, ['✅']);
    assert.deepEqual(h.msg.replies, ['Welcome, the door is open.']);
    assert.deepEqual(h.calls.order, ['door', 'ai']);
    assert.equal(h.calls.ai[0].outcome, 'granted');
    assert.equal(h.calls.ai[0].provider, 'gemini');
    assert.equal(h.calls.ai[0].name, 'Nadia');
    assert.equal(h.calls.audit[0].chatType, scope);
  });
}

test('unlisted DM senders stay silent and never reach AI or the door', async () => {
  const h = harness({ authorized: false });
  await h.run();
  assert.deepEqual(h.msg.replies, []);
  assert.deepEqual(h.msg.reactions, []);
  assert.deepEqual(h.calls.ai, []);
  assert.deepEqual(h.calls.doors, []);
  assert.equal(h.calls.audit[0].reason, 'not_whitelisted');
});

test('unlisted group senders retain the fixed denial reply without calling AI', async () => {
  const h = harness({ scope: 'group', authorized: false });
  await h.run();
  assert.deepEqual(h.msg.reactions, ['⛔']);
  assert.deepEqual(h.msg.replies, [h.settings.replies.denied_not_whitelisted.text]);
  assert.deepEqual(h.calls.ai, []);
  assert.deepEqual(h.calls.doors, []);
});

test('successful opens keep only the reaction when AI returns no usable reply', async () => {
  for (const scope of ['dm', 'group']) {
    for (const replyMode of ['text', 'both']) {
      const h = harness({ scope, generated: null, settings: { replyMode } });
      await h.run();
      assert.equal(h.calls.ai.length, 1);
      assert.deepEqual(h.msg.replies, []);
      assert.deepEqual(h.msg.reactions, ['✅']);
      assert.equal(h.calls.doors.length, 1);
    }
  }
});

test('failed success GIFs never send the canned welcome', async () => {
  for (const replyMode of ['text', 'both']) {
    const h = harness({ generated: { mode: 'gif', gifId: 'coffee_next' },
      settings: { replyMode }, gifError: new Error('GIF unavailable') });
    await h.run();
    assert.deepEqual(h.msg.replies, []);
    assert.deepEqual(h.msg.reactions, ['✅']);
    assert.equal(h.calls.doors.length, 1);
  }
});

test('errors and test mode retain factual fallback text when AI is unavailable', async () => {
  for (const [options, outcome] of [
    [{ doorError: new Error('relay failed') }, 'error'],
    [{ doorResult: { simulated: true } }, 'simulated'],
    [{ doorResult: { unconfirmed: true } }, 'granted_unconfirmed'],
  ]) {
    const h = harness({ ...options, generated: null });
    await h.run();
    assert.deepEqual(h.msg.replies, [renderReply(h.settings, outcome, { door: 'Front door' }).text]);
    assert.equal(h.calls.doors.length, 1);
  }
});

test('AI-disabled and reaction-only modes retain their behavior in DMs', async () => {
  for (const overrides of [{ aiRepliesEnabled: false }, { replyMode: 'react' }]) {
    const h = harness({ settings: overrides });
    await h.run();
    assert.deepEqual(h.calls.ai, []);
    assert.deepEqual(h.msg.reactions, ['✅']);
    assert.deepEqual(h.msg.replies,
      overrides.replyMode === 'react' ? [] : [h.settings.replies.granted.text]);
  }
});

test('an authorized DM failure passes the actual error outcome to AI', async () => {
  const h = harness({ doorError: new Error('relay failed'), generated: 'The request failed.' });
  await h.run();
  assert.equal(h.calls.ai[0].outcome, 'error');
  assert.equal(h.calls.audit[0].decision, 'error');
  assert.deepEqual(h.msg.reactions, ['⚠️']);
  assert.deepEqual(h.msg.replies, ['The request failed.']);
});

test('out-of-scope messages remain ignored before authorization or AI', async () => {
  const h = harness({ scope: null });
  await h.run();
  assert.deepEqual(h.msg.replies, []);
  assert.deepEqual(h.calls.ai, []);
  assert.deepEqual(h.calls.doors, []);
  assert.deepEqual(h.calls.audit, []);
});
