/**
 * Encryption module for the credential vault.
 *
 * Algorithm:  AES-256-GCM (authenticated encryption)
 * KDF:        PBKDF2-SHA256 with 100,000 iterations
 * Salt:       32 bytes derived from a SHA-256 hash of the vault path
 * IV:         16 bytes random per encryption call
 * Auth tag:   16 bytes (GCM default)
 *
 * Wire format (all values hex-encoded, colon-separated):
 *   <iv_hex>:<authTag_hex>:<ciphertext_hex>
 */

import * as crypto from 'crypto';
import { CryptoError } from './types.js';
import type { LoggingCallback } from './types.js';
import { createOperationLogger } from './logger.js';

const ALGORITHM = 'aes-256-gcm' as const;
const KEY_LENGTH = 32; // bytes — AES-256
const IV_LENGTH = 16; // bytes
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';

/**
 * Derives a 32-byte AES key from a passphrase.
 *
 * The salt is deterministically produced from the vault file path so that
 * the same passphrase always yields the same key for a given vault, without
 * storing the salt alongside the ciphertext.
 *
 * @param passphrase  The user passphrase (UTF-8 string).
 * @param vaultPath   Absolute path to the vault file, used to derive the salt.
 */
export function deriveKey(passphrase: string, vaultPath: string): Buffer {
  // 32-byte salt = SHA-256(vaultPath)
  const salt = crypto.createHash('sha256').update(vaultPath, 'utf8').digest();

  return crypto.pbkdf2Sync(
    passphrase,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST,
  );
}

/**
 * Encrypts a UTF-8 plaintext string using AES-256-GCM.
 *
 * @param plaintext   The string to encrypt.
 * @param key         A 32-byte AES key (from deriveKey).
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
