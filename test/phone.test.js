// Pure unit tests - no Mongo, no WhatsApp.
const { normalizePhone, isNationalFormat } = require('../src/whatsapp/phone');
const { digitsOnly, parseJid } = require('../src/whatsapp/identity');

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

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('\n-- normalizePhone (213) --');
eq('national with leading zero', normalizePhone('0549212025'), '213549212025');
eq('international with +', normalizePhone('+213549212025'), '213549212025');
eq('international dialled as 00', normalizePhone('00213549212025'), '213549212025');
eq('already canonical', normalizePhone('213549212025'), '213549212025');
eq('bare national number', normalizePhone('549212025'), '213549212025');
eq('spaces and dashes', normalizePhone('0549 21-20.25'), '213549212025');
eq('parenthesised', normalizePhone('(0)549212025'), '213549212025');
eq('+ with spaces', normalizePhone('+213 549 21 20 25'), '213549212025');

console.log('\n-- rejected --');
eq('empty', normalizePhone(''), null);
eq('null', normalizePhone(null), null);
eq('no digits at all', normalizePhone('not a number'), null);
eq('far too short', normalizePhone('12345'), null);
eq('far too long', normalizePhone('+2135492120251234567'), null);

console.log('\n-- other country codes --');
// A foreign member typed in full must survive untouched.
eq('French number with +', normalizePhone('+33612345678'), '33612345678');
eq('French number already stored', normalizePhone('33612345678'), '33612345678');
eq('configurable country code', normalizePhone('0661234567', '212'), '212661234567');
eq('  and its + form', normalizePhone('+212661234567', '212'), '212661234567');

console.log('\n-- isNationalFormat --');
check('leading zero is national', isNationalFormat('0549212025'));
check('canonical is not', !isNationalFormat('213549212025'));
check('empty is not', !isNationalFormat(''));
check('non-numeric is not', !isNationalFormat('0abc'));

console.log('\n-- digitsOnly is left alone --');
// The whole reason normalizePhone is a separate function: digitsOnly parses
// JIDs, where the number is already exact. Giving it country-code logic would
// mangle a LID.
eq('digitsOnly does not add a country code', digitsOnly('549212025'), '549212025');
eq('a LID user part survives', digitsOnly(parseJid('18712345678901@lid').user), '18712345678901');
eq('a phone JID user part survives', digitsOnly(parseJid('213549212025@c.us').user), '213549212025');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
