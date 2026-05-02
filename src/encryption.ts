/**
 * Encryption module for the credential vault.
 *
 * Algorithm:  AES-256-GCM (authenticated encryption)
 * KDF:        Argon2id (libsodium crypto_pwhash)
 * Salt:       16 bytes derived from a SHA-256 hash of the vault path
 * IV:         16 bytes random per encryption call
 * Auth tag:   16 bytes (GCM default)
 *
 * Wire format (all values hex-encoded, colon-separated):
 *   <iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * Key derivation: Argon2id only. The previous PBKDF2 path (`deriveKey`) was
 * removed in v1.0; vaults / migration bundles encrypted under PBKDF2-derived
 * keys are no longer readable. See docs/security.md for the migration story.
 */

import * as crypto from 'crypto';
// The "sumo" build is required for crypto_pwhash (Argon2id). The base
// `libsodium-wrappers` build omits password-hashing primitives.
import _sodium from 'libsodium-wrappers-sumo';
import { CryptoError } from './types.js';
import type { LoggingCallback } from './types.js';
import { createOperationLogger } from './logger.js';

const ALGORITHM = 'aes-256-gcm' as const;
const KEY_LENGTH = 32; // bytes — AES-256
const IV_LENGTH = 16; // bytes

// Argon2id parameters — INTERACTIVE preset balances UX (~100ms) and resistance
// to GPU/ASIC attacks. For server-side or batch use, switch to MODERATE.
const ARGON2_OPSLIMIT = 2; // crypto_pwhash_OPSLIMIT_INTERACTIVE
const ARGON2_MEMLIMIT = 67_108_864; // 64 MiB — crypto_pwhash_MEMLIMIT_INTERACTIVE
const ARGON2_ALG_ID = 2; // crypto_pwhash_ALG_ARGON2ID13

/**
 * Derives a 32-byte AES key from a passphrase using Argon2id.
 *
 * Argon2id is the OWASP-recommended password-hashing function: it is memory-
 * hard, which makes large-scale GPU/ASIC brute force economically infeasible.
 *
 * The salt is deterministically derived from the vault path so unlocks remain
 * stateless — no separate salt file.
 *
 * @param passphrase  The user passphrase (UTF-8 string).
 * @param vaultPath   Absolute path to the vault file, used to derive the salt.
 * @returns           A 32-byte AES-256 key.
 */
export async function deriveKeyArgon2id(
  passphrase: string,
  vaultPath: string,
): Promise<Buffer> {
  await _sodium.ready;
  const sodium = _sodium;

  // Argon2id requires a 16-byte salt (crypto_pwhash_SALTBYTES). Derive a
  // deterministic 16-byte salt from the vault path so the unlock is stateless.
  const salt = crypto
    .createHash('sha256')
    .update(vaultPath, 'utf8')
    .digest()
    .subarray(0, 16);

  const key = sodium.crypto_pwhash(
    KEY_LENGTH,
    passphrase,
    salt,
    ARGON2_OPSLIMIT,
    ARGON2_MEMLIMIT,
    ARGON2_ALG_ID,
  );

  return Buffer.from(key);
}

/**
 * Best-effort zero a key buffer in place. Node Buffers don't guarantee no
 * copies were made by the JIT, but for short-lived derived keys this still
 * shrinks the window during which a memory scrape could recover the key.
 */
export function zeroizeKey(key: Buffer): void {
  if (!Buffer.isBuffer(key)) return;
  key.fill(0);
}

/**
 * Encrypts a UTF-8 plaintext string using AES-256-GCM.
 *
 * @param plaintext   The string to encrypt.
 * @param key         A 32-byte AES key.
 * @param opts.providerId  Optional provider ID added to error context.
 * @param opts.logger      Optional logging callback.
 * @returns           Wire-format ciphertext string.
 */
export function encrypt(
  plaintext: string,
  key: Buffer,
  opts?: { providerId?: string; logger?: LoggingCallback },
): string {
  const opLog = createOperationLogger('encrypt', opts?.logger);
  try {
    if (!plaintext) {
      throw new CryptoError('Plaintext must not be empty', 'encrypt', opts?.providerId);
    }
    if (key.length !== KEY_LENGTH) {
      throw new CryptoError(
        `Key must be ${KEY_LENGTH} bytes`,
        'encrypt',
        opts?.providerId,
      );
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertextBuf = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    opLog.debug('Encryption successful', { providerId: opts?.providerId });
    return [
      iv.toString('hex'),
      authTag.toString('hex'),
      ciphertextBuf.toString('hex'),
    ].join(':');
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    opLog.error('Encryption failed', { providerId: opts?.providerId });
    throw new CryptoError(
      'Encryption failed',
      'encrypt',
      opts?.providerId,
      err,
    );
  }
}

/**
 * Decrypts a wire-format ciphertext string produced by {@link encrypt}.
 *
 * @param ciphertext  Wire-format string: <iv>:<authTag>:<ciphertext>.
 * @param key         The same 32-byte AES key used during encryption.
 * @param opts.providerId  Optional provider ID added to error context.
 * @param opts.logger      Optional logging callback.
 * @returns           The original plaintext string.
 */
export function decrypt(
  ciphertext: string,
  key: Buffer,
  opts?: { providerId?: string; logger?: LoggingCallback },
): string {
  const opLog = createOperationLogger('decrypt', opts?.logger);
  try {
    if (!ciphertext) {
      throw new CryptoError('Ciphertext must not be empty', 'decrypt', opts?.providerId);
    }
    if (key.length !== KEY_LENGTH) {
      throw new CryptoError(
        `Key must be ${KEY_LENGTH} bytes`,
        'decrypt',
        opts?.providerId,
      );
    }

    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new CryptoError(
        'Invalid ciphertext format — expected iv:authTag:ciphertext',
        'decrypt',
        opts?.providerId,
      );
    }

    const [ivHex, authTagHex, ctHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ct = Buffer.from(ctHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const plaintext =
      decipher.update(ct).toString('utf8') + decipher.final().toString('utf8');

    opLog.debug('Decryption successful', { providerId: opts?.providerId });
    return plaintext;
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    opLog.error('Decryption failed', { providerId: opts?.providerId });
    throw new CryptoError(
      'Decryption failed — wrong passphrase or corrupted vault',
      'decrypt',
      opts?.providerId,
      err,
    );
  }
}
