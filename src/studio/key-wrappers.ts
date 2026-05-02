/**
 * PRF-wrapped DEK envelopes (`key-wrappers.json`) — one wrapped blob per passkey.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { encrypt, decrypt } from '../encryption.js';

const WRAPPER_INFO = Buffer.from('studio-pro:v1:dek-wrap', 'utf8');

export interface KeyWrappersFile {
  version: 1;
  wraps: Array<{
    credentialId: string;
    /** Output of {@link encrypt} — AES-GCM wire string wrapping UTF-8 base64 DEK. */
    ciphertext: string;
  }>;
}

export function keyWrappersPath(storeDir: string): string {
  return path.join(storeDir, 'key-wrappers.json');
}

export function loadKeyWrappers(storeDir: string): KeyWrappersFile {
  const p = keyWrappersPath(storeDir);
  if (!fs.existsSync(p)) {
    return { version: 1, wraps: [] };
  }
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw) as KeyWrappersFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.wraps)) {
    throw new Error('Invalid key-wrappers.json');
  }
  return parsed;
}

export function saveKeyWrappers(storeDir: string, data: KeyWrappersFile): void {
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyWrappersPath(storeDir), JSON.stringify(data, null, 2) + '\n', {
    mode: 0o600,
  });
}

function wrapKeyFromPrf(prfOutputB64url: string): Buffer {
  const prfOut = Buffer.from(prfOutputB64url, 'base64url');
  return Buffer.from(crypto.hkdfSync('sha256', prfOut, Buffer.alloc(0), WRAPPER_INFO, 32));
}

/** AES-GCM wrap DEK (32 bytes) using HKDF(PRF output). */
export function wrapDekWithPrf(prfOutputB64url: string, dek: Buffer): string {
  const wrapKey: Buffer = wrapKeyFromPrf(prfOutputB64url);
  const dekUtf8 = dek.toString('base64');
  return encrypt(dekUtf8, wrapKey, { providerId: 'key-wrappers' });
}

export function unwrapDekWithPrf(prfOutputB64url: string, ciphertext: string): Buffer {
  const wrapKey: Buffer = wrapKeyFromPrf(prfOutputB64url);
  const plain = decrypt(ciphertext, wrapKey, { providerId: 'key-wrappers' });
  return Buffer.from(plain, 'base64');
}

export function upsertWrappedDek(
  storeDir: string,
  credentialId: string,
  prfOutputB64url: string,
  dek: Buffer,
): void {
  const data = loadKeyWrappers(storeDir);
  const ciphertext = wrapDekWithPrf(prfOutputB64url, dek);
  const idx = data.wraps.findIndex((w) => w.credentialId === credentialId);
  const row = { credentialId, ciphertext };
  if (idx >= 0) data.wraps[idx] = row;
  else data.wraps.push(row);
  saveKeyWrappers(storeDir, data);
}

export function getWrappedDekForCredential(storeDir: string, credentialId: string): string | undefined {
  return loadKeyWrappers(storeDir).wraps.find((w) => w.credentialId === credentialId)?.ciphertext;
}
