// Pure unit tests - no Mongo.
const { hashPassword, verifyPassword } = require('../src/security/passwords');

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
  console.log('\n-- hashPassword / verifyPassword --');
  const hash = await hashPassword('correct horse battery staple');

  check('the right password verifies', await verifyPassword('correct horse battery staple', hash));
  check('the wrong password does not', !(await verifyPassword('wrong password', hash)));
  check('is salted: hashing twice gives different output', hash !== (await hashPassword('correct horse battery staple')));
  check('but both still verify the same password', await verifyPassword('correct horse battery staple', await hashPassword('correct horse battery staple')));

  console.log('\n-- malformed input fails closed, never throws --');
  for (const bad of [null, undefined, '', 'not-a-hash-at-all', 'scrypt:onlyonepart', 'md5:deadbeef:deadbeef']) {
    let threw = false;
    let ok = true;
    try {
      ok = await verifyPassword('anything', bad);
    } catch {
      threw = true;
    }
    check(`stored=${JSON.stringify(bad)} -> false, no throw`, !threw && ok === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
