const assert = require('assert');
const cooldown = require('../src/whatsapp/request-cooldown');

cooldown.reset();

assert.strictEqual(cooldown.remainingMs('a', 2, 1_000), 0);
assert.deepStrictEqual(cooldown.take('a', 2, 1_000), { allowed: true, retryAfterSec: 0 });
assert.strictEqual(cooldown.remainingMs('a', 2, 61_000), 60_000);
assert.deepStrictEqual(cooldown.take('a', 2, 61_000), {
  allowed: false,
  retryAfterSec: 60,
});
assert.deepStrictEqual(cooldown.take('other-member', 2, 61_000), {
  allowed: true,
  retryAfterSec: 0,
});
assert.deepStrictEqual(cooldown.take('a', 2, 121_000), { allowed: true, retryAfterSec: 0 });

cooldown.reset();
assert.deepStrictEqual(cooldown.take('disabled', 0, 1_000), { allowed: true, retryAfterSec: 0 });
assert.deepStrictEqual(cooldown.take('disabled', 0, 1_001), { allowed: true, retryAfterSec: 0 });

console.log('request cooldown tests passed');
