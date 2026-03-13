import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';

export function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Encrypts plaintext using AES-256-GCM with PBKDF2 key derivation.
 * Output layout: [salt (32)] [iv (12)] [authTag (16)] [ciphertext]
 */
export function encrypt(plaintext: string, password: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypts a buffer produced by encrypt().
 */
export function decrypt(data: Buffer, password: string): string {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final('utf8');
}
