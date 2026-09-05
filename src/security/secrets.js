const crypto = require('crypto');

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('mindsept:ai-api-credential:v1', 'utf8');

function deriveKey(masterSecret) {
  if (!masterSecret) throw new Error('secret encryption is not configured');
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(String(masterSecret), 'utf8'),
      Buffer.from('mindsept:credentials', 'utf8'),
      Buffer.from('ai-api-keys', 'utf8'),
      32
    )
  );
}

/** Encrypt one secret into a self-contained, authenticated envelope. */
function encryptSecret(value, masterSecret) {
  const plain = String(value || '');
  if (!plain) throw new Error('cannot encrypt an empty secret');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(masterSecret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.'
  );
}

/** Decrypt and authenticate an envelope. Tampering and the wrong master fail closed. */
function decryptSecret(envelope, masterSecret) {
  const [version, ivPart, tagPart, ciphertextPart, extra] = String(envelope || '').split('.');
  if (version !== VERSION || !ivPart || !tagPart || !ciphertextPart || extra !== undefined) {
    throw new Error('invalid encrypted secret');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      deriveKey(masterSecret),
      Buffer.from(ivPart, 'base64url')
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('could not decrypt secret');
  }
}

module.exports = { encryptSecret, decryptSecret };
