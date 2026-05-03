import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VaultManager } from '../vault.js';
import { vaultMetaPath, writeVaultMeta } from './vault-meta.js';

/**
 * Dev-only vault auto-unlock mode.
 *
 * Enabled only for profile-isolated local development and never in production.
 */
export function isDevVaultAutoUnlockEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['STUDIO_PROFILE'] === 'dev' && env['NODE_ENV'] !== 'production';
}

/**
 * Deterministic 32-byte DEK for a specific dev store directory.
 *
 * This keeps vault encryption enabled while avoiding WebAuthn prompts in local
 * development. Different store directories derive different keys.
 */
export function deriveDevVaultDek(storeDir: string): Buffer {
  return crypto
    .createHash('sha256')
    .update('studio-pro-dev-vault-dek:v1\0')
    .update(storeDir, 'utf8')
    .digest();
}

/**
 * True when dev auto-unlock can safely open the current vault.
 *
 * - If no vault file exists yet, dev auto-unlock is safe.
 * - If a vault file exists, require successful decrypt with the dev DEK.
 */
export function canUseDevAutoUnlockForStore(storeDir: string): boolean {
  const vaultPath = path.join(storeDir, 'credentials.enc');
  if (!fs.existsSync(vaultPath)) {
    return true;
  }
  const vm = new VaultManager(vaultPath);
  const dek = deriveDevVaultDek(storeDir);
  try {
    vm.loadVaultFromMasterKey(dek);
    ensureDevVaultMeta(storeDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backfill vault metadata for dev vaults created before meta writes were enforced.
 */
export function ensureDevVaultMeta(storeDir: string): void {
  const vMetaPath = vaultMetaPath(storeDir);
  if (fs.existsSync(vMetaPath)) return;
  const vaultPath = path.join(storeDir, 'credentials.enc');
  if (!fs.existsSync(vaultPath)) return;
  writeVaultMeta(storeDir, { vaultKeyMode: 'dek-v1' });
}
