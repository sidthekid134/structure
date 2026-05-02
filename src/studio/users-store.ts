/**
 * WebAuthn credential metadata for vault unlock (`users.json`).
 * Whether this install can open the vault is determined by the encrypted vault file,
 * key-wrappers, and this file together — see `/api/version` `canDecryptVault`.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface StoredCredential {
  credentialID: string;
  /** Base64-encoded COSE public key bytes */
  credentialPublicKeyB64: string;
  counter: number;
  transports?: string[];
  label?: string;
  /** 32-byte PRF salt for assertion `prf.eval.first` — stored as base64. */
  prfSaltB64: string;
  createdAt: number;
}

export interface UsersFile {
  version: 1;
  userID: string;
  userName: string;
  credentials: StoredCredential[];
}

export function usersStorePath(storeDir: string): string {
  return path.join(storeDir, 'users.json');
}

export function loadUsers(storeDir: string): UsersFile | null {
  const p = usersStorePath(storeDir);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw) as UsersFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.credentials)) {
    throw new Error('Invalid users.json');
  }
  return parsed;
}

export function saveUsers(storeDir: string, data: UsersFile): void {
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(usersStorePath(storeDir), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
