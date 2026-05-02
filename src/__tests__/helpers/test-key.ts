/**
 * Test-only synchronous key derivation.
 *
 * Production code uses `deriveKeyArgon2id` (async) for passphrase-based key
 * derivation. Tests need a sync helper so that `CredentialStore`-style
 * `(purpose) => Buffer` callbacks stay simple. We use `crypto.scryptSync` —
 * also a memory-hard KDF, but it's bundled with Node and runs synchronously.
 *
 * NEVER import this from non-test code.
 */

import * as crypto from 'crypto';

/** Deterministic 32-byte AES key from (passphrase, purpose) for test fixtures. */
export function testDeriveKey(passphrase: string, purpose: string): Buffer {
  const salt = crypto.createHash('sha256').update(purpose, 'utf8').digest();
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}
