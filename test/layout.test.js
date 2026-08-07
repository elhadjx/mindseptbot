/*
 * Layout regression test for the Messages tab.
 *
 * A single wide photo in a conversation used to stretch the pane past the
 * shell, and because the shell clips its overflow everything in the
 * overhanging half went with it: the composer's microphone and send buttons,
 * and every outgoing bubble, which are right-aligned. The tab looked like it
 * was losing sent messages.
 *
 * Reasoning about that from the stylesheet is exactly how it shipped twice,
 * so this renders the real markup against the real stylesheets in Chromium
 * and measures. It needs a browser, so it is deliberately NOT part of
 * `npm test` - run it with `npm run test:layout`.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const STYLES = path.join(__dirname, '..', 'admin', 'src', 'styles');

const css = ['tokens.css', 'base.css', 'layout.css', 'messages.css']
  .map((file) => fs.readFileSync(path.join(STYLES, file), 'utf8'))
  .join('\n')
  // The files @import each other and the webfonts; we concatenate by hand and
  // the fonts are irrelevant to geometry.
  .replace(/@import[^;]+;/g, '');

// Far larger than any pane, as a data URI so the test never hits the network.
const WIDE_IMAGE =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000">' +
      '<rect width="4000" height="3000" fill="#c0673f"/></svg>'
  ).toString('base64');

const html = `<!doctype html><html><head><style>${css}</style></head><body>
<div class="shell shell--flush">
  <aside class="sidebar">
    <div class="brand"><div><div class="brand__name">Mindsept</div><div class="brand__sub">Door access</div></div></div>
    <nav class="nav">
      <button class="nav__item"><span class="nav__icon">◍</span>Connection</button>
      <button class="nav__item nav__item--active"><span class="nav__icon">✉</span>Messages</button>
    </nav>
    <div class="sidebar__foot"><div class="row"><span class="seed"></span><span class="muted">WhatsApp connected</span></div></div>
  </aside>
  <main class="main main--flush"><div class="stack messages-page">
    <div class="page-head"><h1>Messages</h1><p>The full inbox of the linked WhatsApp number.</p></div>
    <div class="messages-shell messages-shell--chat">
      <div class="chat-list">
        <div class="chat-list__head"><input class="input"><button class="btn btn--ghost btn--sm">↻</button></div>
        <div class="chat-list__items">
          <button class="chat-item"><span class="chat-item__avatar">AB</span><span class="chat-item__body">
            <span class="chat-item__row"><span class="chat-item__name">A group with a very long name indeed</span><span class="chat-item__time">12:01</span></span>
            <span class="chat-item__row"><span class="chat-item__preview">You: a very long preview that must ellipsise rather than stretch the pane</span><span class="chat-item__badge">3</span></span>
          </span></button>
        </div>
      </div>
      <div class="conversation">
        <div class="conversation__head">
          <button class="btn btn--ghost btn--sm conversation__back">← Back</button>
          <span class="chat-item__avatar">GR</span>
          <div class="conversation__title">A group with a really quite long title</div>
        </div>
        <div class="conversation__scroll" id="scroll">
          <div class="bubble bubble--in"><div class="bubble__text">hello there</div><div class="bubble__meta">12:00</div></div>
          <div class="bubble bubble--out">
            <a class="bubble__media"><img id="wide" src="${WIDE_IMAGE}"><div class="bubble__caption">a photo</div></a>
            <div class="bubble__meta">12:01</div>
          </div>
          <div class="bubble bubble--out" id="outgoing"><div class="bubble__text">a message I sent</div><div class="bubble__meta">12:02</div></div>
          <div class="bubble bubble--in"><a class="bubble__document"><span>📎</span><span>a-really-long-document-filename-that-goes-on-and-on-forever.pdf</span></a><div class="bubble__meta">12:03</div></div>
          <div class="bubble bubble--in"><div class="bubble__media"><audio controls class="bubble__audio"></audio></div><div class="bubble__meta">12:04</div></div>
        </div>
        <form class="composer" id="composer">
          <button type="button" class="btn btn--ghost composer__icon">📎</button>
          <input class="input composer__input">
          <button type="button" class="btn btn--ghost composer__icon" id="mic">🎤</button>
        </form>
      </div>
    </div>
  </div></main>
</div></body></html>`;

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

// Sub-pixel rounding means an element can sit a hair past its container
// without anything actually being clipped.
const SLACK = 1;

async function main() {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const [label, width, height] of [
    ['desktop 1280x900', 1280, 900],
    ['tablet 900x900', 900, 900],
    ['phone 390x844', 390, 844],
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent(html, { waitUntil: 'load' });

    console.log(`\n-- ${label} --`);

    const m = await page.evaluate(() => {
      // DOMRect has no own enumerable properties, so it serializes to {}.
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return {
          left: b.left,
          right: b.right,
          width: b.width,
          top: b.top,
          bottom: b.bottom,
          height: b.height,
        };
      };
      const scroller = document.querySelector('#scroll');
      const head = document.querySelector('.page-head');
      return {
        headVisible: head ? getComputedStyle(head).display !== 'none' : false,
        nav: box('.nav'),
        composer: box('#composer'),
        scroller: box('#scroll'),
        vh: window.innerHeight,
        pageScrollW: document.documentElement.scrollWidth,
        pageClientW: document.documentElement.clientWidth,
        shell: box('.messages-shell'),
        conversation: box('.conversation'),
        mic: box('#mic'),
        outgoing: box('#outgoing'),
        image: box('#wide'),
        scrollerOverflowX: scroller.scrollWidth - scroller.clientWidth,
      };
    });

    check(
      'the page never scrolls sideways',
      m.pageScrollW <= m.pageClientW,
      `${m.pageScrollW} > ${m.pageClientW}`
    );
    check(
      'the conversation fits inside the shell',
      m.conversation.right <= m.shell.right + SLACK,
      `${m.conversation.right} > ${m.shell.right}`
    );
    check(
      'the conversation scroller has no sideways overflow',
      m.scrollerOverflowX <= 0,
      String(m.scrollerOverflowX)
    );
    check(
      'an oversized photo is contained',
      m.image.right <= m.shell.right + SLACK,
      `image ${m.image.right} vs shell ${m.shell.right}`
    );
    check(
      'the microphone button is on screen',
      m.mic.right <= m.pageClientW && m.mic.width > 0,
      `mic right ${m.mic.right}, viewport ${m.pageClientW}`
    );
    check(
      'the microphone button is inside the shell',
      m.mic.right <= m.shell.right + SLACK,
      `mic ${m.mic.right} vs shell ${m.shell.right}`
    );
    // Outgoing bubbles are right-aligned, so they are the first thing lost
    // when the pane overhangs its container.
    check(
      'an outgoing bubble is fully visible',
      m.outgoing.right <= m.shell.right + SLACK && m.outgoing.left >= m.shell.left - SLACK,
      `${m.outgoing.left}..${m.outgoing.right} vs ${m.shell.left}..${m.shell.right}`
    );

    // Below the breakpoint the conversation claims the screen; above it, it
    // stays a card in the page.
    if (width <= 860) {
      check('the page title gives way to the conversation', m.headVisible === false);
      check(
        'the conversation runs edge to edge',
        m.shell.left <= SLACK && m.shell.right >= m.pageClientW - SLACK,
        `${m.shell.left}..${m.shell.right} of ${m.pageClientW}`
      );
      check(
        'the composer clears the tab bar',
        m.composer.bottom <= m.nav.top + SLACK,
        `composer ${m.composer.bottom} vs tab bar ${m.nav.top}`
      );
      check(
        'the tab bar is flush with the bottom',
        Math.abs(m.nav.bottom - m.vh) <= SLACK,
        `${m.nav.bottom} vs ${m.vh}`
      );
      const share = (m.scroller.height / m.vh) * 100;
      check('the messages take most of the screen', share > 60, `${share.toFixed(1)}%`);
    } else {
      check('the page keeps its title on a wide screen', m.headVisible === true);
      check('the conversation stays a card', m.shell.left > SLACK, `left ${m.shell.left}`);
    }

    await page.close();
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
