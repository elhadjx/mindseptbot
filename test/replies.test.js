const {
  OUTCOMES,
  OUTCOME_KEYS,
  OUTCOME_DECISION,
  defaultReplies,
  fillPlaceholders,
  renderReply,
  graphemeLength,
} = require('../src/whatsapp/replies');

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

console.log('\n-- catalogue --');
check('every outcome has a key, label and hint', OUTCOMES.every((o) => o.key && o.label && o.hint));
check('every outcome maps to an audit decision', OUTCOME_KEYS.every((k) => OUTCOME_DECISION[k]));
check(
  'defaults cover every outcome',
  OUTCOME_KEYS.every((k) => defaultReplies()[k]?.emoji !== undefined)
);
check(
  'denied outcomes are all marked denied',
  OUTCOME_KEYS.filter((k) => k.startsWith('denied_')).every((k) => OUTCOME_DECISION[k] === 'denied')
);

console.log('\n-- placeholders --');
check(
  'known placeholders are filled',
  fillPlaceholders('Salut {name}, {door} ouverte', { name: 'Amina', door: 'Front door' }) ===
    'Salut Amina, Front door ouverte'
);
check(
  'unknown placeholders are left visible, not blanked',
  fillPlaceholders('Hello {nope}', { name: 'x' }) === 'Hello {nope}',
  fillPlaceholders('Hello {nope}', { name: 'x' })
);
check(
  'a missing value leaves the token alone',
  fillPlaceholders('Hi {name}', {}) === 'Hi {name}'
);
check('text without placeholders is untouched', fillPlaceholders('plain', {}) === 'plain');

console.log('\n-- rendering --');
let r = renderReply({}, 'granted');
check('falls back to the default when nothing is configured', r.emoji === '✅' && r.text === 'Ouvert 🚪');

r = renderReply({ replies: { granted: { emoji: '🚀', text: 'Go {name}' } } }, 'granted', {
  name: 'Sam',
});
check('uses the configured emoji', r.emoji === '🚀');
check('  and fills the configured text', r.text === 'Go Sam');

// Empty string is a real choice - "stay quiet" - not a missing value.
r = renderReply({ replies: { granted: { emoji: '', text: '' } } }, 'granted');
check('an empty emoji stays empty rather than reverting to the default', r.emoji === '');
check('  and so does an empty text', r.text === '');

// Only one of the two configured is a partial override.
r = renderReply({ replies: { granted: { emoji: '🚀' } } }, 'granted');
check('a partial override keeps the default for the other field', r.emoji === '🚀' && r.text === 'Ouvert 🚪');

r = renderReply({}, 'no_such_outcome');
check('an unknown outcome renders empty instead of throwing', r.emoji === '' && r.text === '');

console.log('\n-- emoji length (what the API validates) --');
check('a plain emoji is one grapheme', graphemeLength('✅') === 1);
check('a ZWJ family emoji is still one grapheme', graphemeLength('👨‍👩‍👧') === 1, String(graphemeLength('👨‍👩‍👧')));
check('an emoji with a skin-tone modifier is one', graphemeLength('👍🏽') === 1, String(graphemeLength('👍🏽')));
check('two emoji are two', graphemeLength('✅✅') === 2);
check('empty is zero', graphemeLength('') === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
