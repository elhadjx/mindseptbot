const assert = require('assert');
const { encryptSecret, decryptSecret } = require('../src/security/secrets');

const plaintext = 'sk-test-super-secret-value';
const masterSecret = 'a-long-session-secret-used-only-for-this-test';
const first = encryptSecret(plaintext, masterSecret);
const second = encryptSecret(plaintext, masterSecret);

assert.match(first, /^v1\.[^.]+\.[^.]+\.[^.]+$/);
assert.notStrictEqual(first, second, 'random IVs must produce different envelopes');
assert.ok(!first.includes(plaintext), 'the envelope must not contain plaintext');
assert.strictEqual(decryptSecret(first, masterSecret), plaintext);
assert.strictEqual(decryptSecret(second, masterSecret), plaintext);
assert.throws(() => decryptSecret(first, 'the-wrong-secret'), /could not decrypt/);

const parts = first.split('.');
parts[3] = `${parts[3].slice(0, -1)}${parts[3].endsWith('A') ? 'B' : 'A'}`;
assert.throws(() => decryptSecret(parts.join('.'), masterSecret), /could not decrypt/);
assert.throws(() => decryptSecret('not-an-envelope', masterSecret), /invalid encrypted secret/);

console.log('Secret encryption tests passed');
