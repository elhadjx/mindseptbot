// Exercises the rules that decide whether an incoming WhatsApp message is
// worth a push - and, when several arrive at once, that only one goes out.
// Every dependency is injected, so this needs no Mongo, no linked session and
// no real clock.
const { createMessageNotifier, previewOf } = require('../src/notify/message-alert');

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

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

function message(patch = {}) {
  return {
    id: 'false_x@c.us_A1',
    body: 'salut',
    timestamp: NOW_SEC,
    fromMe: false,
    author: null,
    notifyName: 'Karim',
    type: 'chat',
    hasMedia: false,
    ...patch,
  };
}

/**
 * A notifier wired to fakes: pushes are collected, and the burst window is
 * fired by hand so the tests never wait on a timer.
 */
function harness({ messageAlerts = true, title = 'Karim Benali' } = {}) {
  const pushes = [];
  const timers = [];

  const notifier = createMessageNotifier({
    sendPush: async (payload, options) => {
      pushes.push({ payload, options });
      return 1;
    },
    loadSettings: async () => ({ messageAlerts }),
    chatTitle: async () => title,
    schedule: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    now: () => NOW_MS,
  });

  return {
    pushes,
    notifier,
    // Close every open burst window, then let the flushes settle.
    async fireTimers() {
      const due = timers.splice(0);
      due.forEach((fn) => fn());
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function run() {
  console.log('message-alert');

  // --- what gets through, and what it looks like ---
  {
    const h = harness();
    await h.notifier.handle({ chatId: '212600000000@c.us', message: message() });
    check('a message opens a window rather than pushing at once', h.pushes.length === 0);
    await h.fireTimers();
    check('the window closing sends one push', h.pushes.length === 1);

    const { payload, options } = h.pushes[0] || {};
    check('titled with the chat name', payload?.title === 'Karim Benali', payload?.title);
    check('the body is the message', payload?.body === 'salut', payload?.body);
    check('tagged per chat', payload?.tag === 'chat:212600000000@c.us', payload?.tag);
    check(
      'links to the conversation',
      payload?.url === `/#messages/${encodeURIComponent('212600000000@c.us')}`,
      payload?.url
    );
    check('does not demand a tap', payload?.requireInteraction === false);
    check('sent at normal urgency', options?.urgency === 'normal', options?.urgency);
  }

  // --- a group names the speaker, since the title is the group ---
  {
    const h = harness({ title: 'Porte Nord' });
    await h.notifier.handle({
      chatId: '120363000000000000@g.us',
      message: message({ author: '212600000000@c.us', notifyName: 'Sara' }),
    });
    await h.fireTimers();
    check('a group push names the sender', h.pushes[0]?.payload.body === 'Sara: salut',
      h.pushes[0]?.payload.body);
  }

  // --- a burst becomes one push, carrying the newest message ---
  {
    const h = harness();
    const chatId = '212600000000@c.us';
    await h.notifier.handle({ chatId, message: message({ body: 'un' }) });
    await h.notifier.handle({ chatId, message: message({ body: 'deux' }) });
    await h.notifier.handle({ chatId, message: message({ body: 'trois' }) });
    await h.fireTimers();
    check('three messages in a burst send one push', h.pushes.length === 1, `${h.pushes.length}`);
    check(
      'the push counts them and shows the latest',
      h.pushes[0]?.payload.body === '3 nouveaux messages · trois',
      h.pushes[0]?.payload.body
    );
  }

  // --- two chats are two notifications, not one ---
  {
    const h = harness();
    await h.notifier.handle({ chatId: '212600000000@c.us', message: message() });
    await h.notifier.handle({ chatId: '212611111111@c.us', message: message() });
    await h.fireTimers();
    check('separate chats push separately', h.pushes.length === 2, `${h.pushes.length}`);
  }

  // --- everything that must stay quiet ---
  {
    const cases = [
      ['our own outgoing message', '212600000000@c.us', message({ fromMe: true })],
      ['a status update', 'status@broadcast', message()],
      ['a channel', '120363000000000000@newsletter', message()],
      ['a broadcast list', '212600000000@broadcast', message()],
      ['a replayed backlog message', '212600000000@c.us', message({ timestamp: NOW_SEC - 600 })],
    ];

    for (const [label, chatId, msg] of cases) {
      const h = harness();
      await h.notifier.handle({ chatId, message: msg });
      await h.fireTimers();
      check(`no push for ${label}`, h.pushes.length === 0, `${h.pushes.length} sent`);
    }

    const off = harness({ messageAlerts: false });
    await off.notifier.handle({ chatId: '212600000000@c.us', message: message() });
    await off.fireTimers();
    check('no push when the setting is off', off.pushes.length === 0);
  }

  // --- naming a chat we could not look up ---
  {
    const h = harness({ title: null });
    await h.notifier.handle({ chatId: '212600000000@c.us', message: message() });
    await h.fireTimers();
    check(
      'falls back to the pushname when the title is unknown',
      h.pushes[0]?.payload.title === 'Karim',
      h.pushes[0]?.payload.title
    );

    const anon = harness({ title: null });
    await anon.notifier.handle({
      chatId: '212600000000@c.us',
      message: message({ notifyName: null }),
    });
    await anon.fireTimers();
    check(
      'falls back to the number when there is no name at all',
      anon.pushes[0]?.payload.title === '212600000000',
      anon.pushes[0]?.payload.title
    );
  }

  // --- previews ---
  check('a photo previews as a photo', previewOf({ hasMedia: true, type: 'image' }) === '📷 Photo');
  check(
    'a voice note previews as one',
    previewOf({ hasMedia: true, type: 'ptt' }) === '🎤 Message vocal'
  );
  check(
    'a captioned photo previews as its caption',
    previewOf({ hasMedia: true, type: 'image', body: 'la porte' }) === 'la porte'
  );
  check(
    'a long message is truncated',
    previewOf({ body: 'a'.repeat(500) }).length === 180 &&
      previewOf({ body: 'a'.repeat(500) }).endsWith('…')
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
