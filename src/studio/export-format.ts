/**
 * Encrypted project migration bundles (`structure-export-v1`).
 *
 * Two key paths:
 *   - **Passphrase** — user types a passphrase; we derive an AES key via
 *     Argon2id. Portable across machines.
 *   - **Vault row key** — derived from the active vault DEK (passkey-unlocked).
 *     Same machine only.
 */

import { encrypt, decrypt, deriveKeyArgon2id } from '../encryption.js';
import { deriveStructureRowKey } from './row-crypto.js';

export const STRUCTURE_EXPORT_PURPOSE = 'structure-export-envelope:v1';

export async function sealMigrationExport(
  storeDir: string,
  payload: unknown,
  passphrase?: string,
): Promise<string> {
  const key = passphrase
    ? await deriveKeyArgon2id(passphrase, STRUCTURE_EXPORT_PURPOSE)
    : deriveStructureRowKey(storeDir, STRUCTURE_EXPORT_PURPOSE);
  return encrypt(JSON.stringify(payload), key, { providerId: 'structure-export' });
}

export async function openMigrationExport(
  storeDir: string,
  ciphertext: string,
  passphrase?: string,
): Promise<unknown> {
  // Try passphrase-based key first (portable). Fall back to current vault key
  // so bundles exported without a passphrase still import transparently as
  // long as the vault hasn't changed.
  if (passphrase) {
    const passphraseKey = await deriveKeyArgon2id(passphrase, STRUCTURE_EXPORT_PURPOSE);
    try {
      return JSON.parse(decrypt(ciphertext, passphraseKey, { providerId: 'structure-export' })) as unknown;
    } catch {
      // passphrase didn't match — fall through and try the vault key
    }
  }
  const vaultKey = deriveStructureRowKey(storeDir, STRUCTURE_EXPORT_PURPOSE);
  return JSON.parse(decrypt(ciphertext, vaultKey, { providerId: 'structure-export' })) as unknown;
}
