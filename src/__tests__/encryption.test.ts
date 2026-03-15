import { deriveKey, encrypt, decrypt } from '../encryption';
import { CryptoError } from '../types';
import * as crypto from 'crypto';

const VAULT_PATH = '/home/user/.platform/credentials.enc';
const PASSPHRASE = 'super-secret-passphrase-123!';

describe('deriveKey', () => {
  it('returns a 32-byte buffer', () => {
    const key = deriveKey(PASSPHRASE, VAULT_PATH);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it('is deterministic for the same passphrase + path', () => {
    const k1 = deriveKey(PASSPHRASE, VAULT_PATH);
    const k2 = deriveKey(PASSPHRASE, VAULT_PATH);
    expect(k1.equals(k2)).toBe(true);
  });

  it('produces different keys for different passphrases', () => {
    const k1 = deriveKey(PASSPHRASE, VAULT_PATH);
    const k2 = deriveKey('different-passphrase-456!', VAULT_PATH);
    expect(k1.equals(k2)).toBe(false);
  });

  it('produces different keys for different vault paths', () => {
    const k1 = deriveKey(PASSPHRASE, VAULT_PATH);
    const k2 = deriveKey(PASSPHRASE, '/other/path/credentials.enc');
    expect(k1.equals(k2)).toBe(false);
  });
});

describe('encrypt / decrypt round-trip', () => {
  let key: Buffer;

  beforeEach(() => {
    key = deriveKey(PASSPHRASE, VAULT_PATH);
  });

  it('encrypts and decrypts a string correctly', () => {
    const plaintext = 'hello, vault!';
    const ct = encrypt(plaintext, key);
    expect(decrypt(ct, key)).toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const pt = 'same plaintext';
    const ct1 = encrypt(pt, key);
    const ct2 = encrypt(pt, key);
    expect(ct1).not.toBe(ct2);
    expect(decrypt(ct1, key)).toBe(pt);
    expect(decrypt(ct2, key)).toBe(pt);
  });

  it('ciphertext has iv:authTag:data format', () => {
    const ct = encrypt('test', key);
    const parts = ct.split(':');
    expect(parts).toHaveLength(3);
    // IV: 16 bytes = 32 hex chars
    expect(parts[0]).toHaveLength(32);
    // Auth tag: 16 bytes = 32 hex chars
    expect(parts[1]).toHaveLength(32);
  });

  it('throws CryptoError when decrypting with wrong key', () => {
    const ct = encrypt('secret data', key);
    const wrongKey = crypto.randomBytes(32);
    expect(() => decrypt(ct, wrongKey)).toThrow(CryptoError);
  });

  it('throws CryptoError on tampered ciphertext', () => {
    const ct = encrypt('secret data', key);
    const parts = ct.split(':');
    // Flip last char of ciphertext
    parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith('f') ? '0' : 'f');
    expect(() => decrypt(parts.join(':'), key)).toThrow(CryptoError);
  });

  it('throws CryptoError on empty plaintext', () => {
    expect(() => encrypt('', key)).toThrow(CryptoError);
  });

  it('throws CryptoError on empty ciphertext', () => {
    expect(() => decrypt('', key)).toThrow(CryptoError);
  });

  it('throws CryptoError on malformed ciphertext', () => {
    expect(() => decrypt('not:valid', key)).toThrow(CryptoError);
  });

  it('throws CryptoError on wrong-length key for encrypt', () => {
    expect(() => encrypt('test', Buffer.from('short'))).toThrow(CryptoError);
  });

  it('calls logging callback on success', () => {
    const logs: string[] = [];
    const logger = (e: { message: string }) => logs.push(e.message);
    encrypt('data', key, { logger: logger as never });
    expect(logs.length).toBeGreaterThan(0);
  });
});
