// Reading "did it open?" answers. Pure functions and an in-memory map, so no
// Mongo and no WhatsApp - just the words people actually type.
const {
  parseAnswer,
  rememberQuestion,
  chatHasQuestion,
  takeQuestion,
  reset,
} = require('../src/whatsapp/confirmations');

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

function expect(body, want) {
  const got = parseAnswer(body);
  check(`${JSON.stringify(body)} reads as ${want}`, got === want, `got ${got}`);
}

console.log('\n-- yes, in the languages people answer in --');
// French, including the spoken forms.
['oui', 'Ouais', 'ok', 'OK', "c'est bon", 'ça a marché', 'nickel', 'elle est ouverte'].forEach((t) =>
  expect(t, 'yes')
);
// Darija in latin script, where digits stand in for Arabic letters.
['wah', 'wa7', 'ih', 'iyeh', 'safi', 'tmam', 'na3am', 't7alat'].forEach((t) => expect(t, 'yes'));
// Arabic script.
['نعم', 'واه', 'ايه', 'صافي', 'تمام'].forEach((t) => expect(t, 'yes'));
expect('👍', 'yes');

console.log('\n-- no --');
['non', 'nan', 'rien', 'toujours fermée', "ça marche pas"].forEach((t) => expect(t, 'no'));
['la', 'lla', 'walou', 'makach', 'mazal', 'ma7abatch', 'mghelka'].forEach((t) => expect(t, 'no'));
['لا', 'والو', 'ماكاش', 'مازال'].forEach((t) => expect(t, 'no'));
expect('👎', 'no');

console.log('\n-- spelling is not meaning --');
expect('waaaaah', 'yes');
expect('OUIIII', 'yes');
expect('laaa', 'no');
expect('wah merci', 'yes');
expect('merci wah', 'yes');
expect('non merci', 'no');

console.log('\n-- and everything else is left alone --');
// The darija for "no" is also the French word for "the". Matching a substring
// would read this one exactly backwards.
expect('la porte est ouverte', null);
expect('la porte ne marche pas', null);
expect('merci', null);
expect('hello', null);
expect('/open', null);
expect('', null);
expect(null, null);

console.log('\n-- who was asked --');
reset();
const GROUP = '120363000000000000@g.us';
const OTHER = '120363111111111111@g.us';

check('a quiet chat has nothing pending', chatHasQuestion(GROUP) === false);

rememberQuestion({
  chatId: GROUP,
  actorKey: 'sam@c.us',
  auditId: 'audit-1',
  door: 'front',
  label: 'Front door',
});
check('asking someone registers the question', chatHasQuestion(GROUP) === true);
check('  but only in their chat', chatHasQuestion(OTHER) === false);
check('  and only for them', takeQuestion(GROUP, 'alex@c.us') === null);

const claimed = takeQuestion(GROUP, 'sam@c.us');
check('the person asked can answer it', claimed?.auditId === 'audit-1');
check('  and it is consumed', takeQuestion(GROUP, 'sam@c.us') === null);
check('  leaving the chat quiet again', chatHasQuestion(GROUP) === false);

// Two people can be waiting on the same door in the same group.
rememberQuestion({ chatId: GROUP, actorKey: 'sam@c.us', auditId: 'a', door: 'front' });
rememberQuestion({ chatId: GROUP, actorKey: 'alex@c.us', auditId: 'b', door: 'front' });
check('each person answers for their own attempt', takeQuestion(GROUP, 'alex@c.us')?.auditId === 'b');
check('  without consuming the other', takeQuestion(GROUP, 'sam@c.us')?.auditId === 'a');

// A second blind open by the same person replaces the first: the question they
// are looking at is the new one.
rememberQuestion({ chatId: GROUP, actorKey: 'sam@c.us', auditId: 'first', door: 'front' });
rememberQuestion({ chatId: GROUP, actorKey: 'sam@c.us', auditId: 'second', door: 'front' });
check('a fresh question replaces the stale one', takeQuestion(GROUP, 'sam@c.us')?.auditId === 'second');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
