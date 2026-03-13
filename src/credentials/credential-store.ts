import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;       // 256-bit key
const SALT_LENGTH = 32;      // random salt per encryption
const IV_LENGTH = 12;        // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16;  // 128-bit GCM auth tag

// scrypt parameters (Argon2-equivalent memory-hard KDF, built into Node.js)
const SCRYPT_N = 16384;   // CPU/memory cost factor
const SCRYPT_R = 8;       // block size
const SCRYPT_P = 1;       // parallelism

// Master password hash storage
const PROVISIONING_DIR = join(homedir(), '.provisioning');
const MASTER_KEY_FILE = join(PROVISIONING_DIR, 'master.key');

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

function ensureProvisioningDir(): void {
  if (!existsSync(PROVISIONING_DIR)) {
    mkdirSync(PROVISIONING_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Derives a 256-bit key from a password and salt using scrypt (Argon2-equivalent).
 */
function deriveKeyAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function deriveKeySync(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

// -----------------------------------------------------------------------
// CredentialStore
// -----------------------------------------------------------------------

/**
 * Stateless encryption/decryption service for provider credentials.
 *
 * Wire format (binary): [salt (32)] [iv (12)] [authTag (16)] [ciphertext]
 * Public API returns/accepts base64 strings for safe text storage (e.g. in a DB TEXT column).
 *
 * Key derivation uses scrypt with parameters equivalent to Argon2id defaults.
 * The master password hash is stored at ~/.provisioning/master.key.
 */
export class CredentialStore {
  /**
   * Encrypts plaintext with the given master password.
   * Returns a base64-encoded string suitable for storing in the database.
   */
  static async encrypt(plaintext: string, masterPassword: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = await deriveKeyAsync(masterPassword, salt);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const payload = Buffer.concat([salt, iv, authTag, encrypted]);
    return payload.toString('base64');
  }

  /**
   * Decrypts a base64-encoded ciphertext produced by encrypt().
   * Returns the original plaintext string.
   * Throws if the password is wrong or the data is tampered with.
   */
  static async decrypt(ciphertext: string, masterPassword: string): Promise<string> {
    const data = Buffer.from(ciphertext, 'base64');

    const salt = data.subarray(0, SALT_LENGTH);
    const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

    const key = await deriveKeyAsync(masterPassword, salt);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
  }

  // -----------------------------------------------------------------------
  // Master password management
  // -----------------------------------------------------------------------

  /**
   * Returns true if a master password hash has been stored.
   */
  static hasMasterPassword(): boolean {
    return existsSync(MASTER_KEY_FILE);
  }

  /**
   * Hashes the master password with scrypt and stores it at ~/.provisioning/master.key.
   * The file is created with mode 0o600 (owner read/write only).
   */
  static storeMasterPasswordHash(masterPassword: string): void {
    ensureProvisioningDir();
    const salt = randomBytes(32);
    const hash = deriveKeySync(masterPassword, salt);
    const stored = `${salt.toString('hex')}:${hash.toString('hex')}`;
    writeFileSync(MASTER_KEY_FILE, stored, { mode: 0o600 });
  }

  /**
   * Verifies a candidate master password against the stored hash.
   * Returns true if the password matches.
   */
  static verifyMasterPassword(candidate: string): boolean {
    if (!existsSync(MASTER_KEY_FILE)) return false;
    const stored = readFileSync(MASTER_KEY_FILE, 'utf8').trim();
    const [saltHex, hashHex] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expectedHash = Buffer.from(hashHex, 'hex');
    const actualHash = deriveKeySync(candidate, salt);
    return timingSafeEqual(expectedHash, actualHash);
  }
}
