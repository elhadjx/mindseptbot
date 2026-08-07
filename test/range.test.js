// Byte-range parsing for the media endpoint. A voice note that won't scrub is
// the symptom when this is wrong.
const { resolveRange } = require('../src/http/range');

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

const SIZE = 20;

console.log('\n-- no range --');
check('absent header means send everything', resolveRange(undefined, SIZE) === null);
check('empty header too', resolveRange('', SIZE) === null);
check('a bare "bytes=-" carries no numbers', resolveRange('bytes=-', SIZE) === null);
check('garbage is ignored rather than fatal', resolveRange('bytes=abc', SIZE) === null);
check('other units are not ours to serve', resolveRange('items=0-5', SIZE) === null);

console.log('\n-- explicit window --');
let r = resolveRange('bytes=5-9', SIZE);
check('start and end come through', r.satisfiable && r.start === 5 && r.end === 9, JSON.stringify(r));

console.log('\n-- open ended (how playback opens a file) --');
r = resolveRange('bytes=0-', SIZE);
check('runs to the last byte', r.satisfiable && r.start === 0 && r.end === 19, JSON.stringify(r));

console.log('\n-- suffix: the LAST n bytes, not the first --');
r = resolveRange('bytes=-4', SIZE);
check('anchors to the end', r.satisfiable && r.start === 16 && r.end === 19, JSON.stringify(r));
r = resolveRange('bytes=-999', SIZE);
check('a suffix bigger than the file is the whole file', r.satisfiable && r.start === 0 && r.end === 19);
check('a zero-length suffix is unsatisfiable', resolveRange('bytes=-0', SIZE).satisfiable === false);

console.log('\n-- clamping --');
r = resolveRange('bytes=15-999', SIZE);
check('an end past EOF is clamped', r.satisfiable && r.start === 15 && r.end === 19, JSON.stringify(r));
r = resolveRange('bytes=19-19', SIZE);
check('the final byte alone works', r.satisfiable && r.start === 19 && r.end === 19);

console.log('\n-- unsatisfiable --');
check('a start past EOF', resolveRange('bytes=99-', SIZE).satisfiable === false);
check('start exactly at EOF', resolveRange(`bytes=${SIZE}-`, SIZE).satisfiable === false);
check('an inverted window', resolveRange('bytes=9-5', SIZE).satisfiable === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
