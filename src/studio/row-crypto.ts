/**
 * Row-level AES keys — HKDF from vault DEK (passkey-unlocked session).
 */

import * as crypto from 'crypto';
import { getVaultSession, VaultSealedError } from './vault-session.js';

export function deriveStructureRowKey(_storeDir: string, purpose: string): Buffer {
  try {
    const dek = getVaultSession().getVaultDEK();
    return Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), Buffer.from(purpose, 'utf8'), 32));
  } catch (e) {
    if (e instanceof VaultSealedError) throw e;
    throw e;
  }
}

/** Master AES key for `credentials.enc` (raw 32-byte DEK). */
export function getVaultFileMasterKey(_storeDir: string): Buffer {
  return getVaultSession().getVaultDEK();
}
